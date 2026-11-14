import { GraphError, InvalidArgumentError } from './errors.js';
import type { IndexSpec } from './index-spec.js';
import type { SqlDriver } from './storage/driver.js';

/** Turns text into vectors for one pinned IndexSpec. */
export interface Embedder {
  spec(): IndexSpec;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * Optional nearest-neighbour storage for chunk embeddings. Memory works fully
 * without one (full-text search only); any vector database can implement this.
 */
export interface VectorStore {
  /** Create or open an index; opening it with a different embedder fingerprint is refused. */
  ensureIndex(spec: IndexSpec): Promise<void>;
  upsert(spec: IndexSpec, vectors: ReadonlyMap<string, readonly number[]>): Promise<void>;
  /** The k nearest chunk ids by cosine similarity, best first. */
  nearest(spec: IndexSpec, query: readonly number[], k: number): Promise<Array<{ chunkId: string; score: number }>>;
  /** Which of these chunk ids have no vector yet (at most 500 per call). */
  missing(spec: IndexSpec, chunkIds: readonly string[]): Promise<string[]>;
  /** Remove every vector for these chunk ids, in every index. Returns how many went. */
  forget(chunkIds: readonly string[]): Promise<number>;
  method(): string;
}

export const MAX_K = 1000;

/**
 * Validate a vector AS IT WILL BE STORED (float32): a value that is finite and
 * non-zero as a JS number can underflow to 0 or overflow to Infinity in
 * float32, and one such stored vector would poison every later search.
 */
export function float32(spec: IndexSpec, vector: unknown): Float32Array {
  if (!Array.isArray(vector) || vector.length !== spec.dimensions) {
    throw new GraphError(`Expected a list of ${spec.dimensions} numbers for index [${spec.name}].`);
  }
  for (const x of vector) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new GraphError('Vectors must contain only finite numbers.');
    }
  }
  const stored = Float32Array.from(vector as number[]);
  let sum = 0;
  for (const x of stored) {
    if (!Number.isFinite(x)) {
      throw new GraphError('A vector value is too large to store as float32.');
    }
    sum += x * x;
  }
  if (!Number.isFinite(sum) || sum === 0) {
    throw new GraphError('A vector must have a non-zero, finite length once stored as float32.');
  }

  return stored;
}

/**
 * Exact (brute-force) cosine search over packed little-endian float32, the
 * same format as the PHP reference's PdoVectorStore. No extension needed;
 * correct at small-to-medium scale.
 */
export class SqliteVectorStore implements VectorStore {
  constructor(private readonly db: SqlDriver, private readonly indexes = 'graph_vector_indexes', private readonly vectors = 'graph_vectors') {
    for (const table of [indexes, vectors]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) {
        throw new InvalidArgumentError('Invalid table name.');
      }
    }
  }

  method(): string {
    return 'brute-force';
  }

  async ensureIndex(spec: IndexSpec): Promise<void> {
    await this.db.atomic(async () => {
      const existing = await this.fingerprintOf(spec.name);
      if (existing === null) {
        await this.db.run(
          `INSERT INTO ${this.indexes} (name, fingerprint, provider, model, dimensions, recipe) VALUES (?, ?, ?, ?, ?, ?)`,
          [spec.name, spec.fingerprint(), spec.provider, spec.model, spec.dimensions, spec.recipe],
        );

        return;
      }
      this.assertPinned(spec, existing);
    });
  }

  async upsert(spec: IndexSpec, vectors: ReadonlyMap<string, readonly number[]>): Promise<void> {
    this.assertPinned(spec, await this.fingerprintOf(spec.name));
    const packed = [...vectors].map(([id, vector]) => [id, pack(float32(spec, [...vector]))] as const);
    await this.db.atomic(async () => {
      for (const [id, bytes] of packed) {
        await this.db.run(
          `INSERT INTO ${this.vectors} (index_name, chunk_id, vector) VALUES (?, ?, ?)
           ON CONFLICT (index_name, chunk_id) DO UPDATE SET vector = excluded.vector`,
          [spec.name, id, bytes],
        );
      }
    });
  }

  async nearest(spec: IndexSpec, query: readonly number[], k: number): Promise<Array<{ chunkId: string; score: number }>> {
    this.assertPinned(spec, await this.fingerprintOf(spec.name));
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      throw new InvalidArgumentError(`k must be between 1 and ${MAX_K}.`);
    }
    const q = float32(spec, [...query]);
    const qn = norm(q);
    const scores: Array<{ chunkId: string; score: number }> = [];
    for (const row of await this.db.all(`SELECT chunk_id, vector FROM ${this.vectors} WHERE index_name = ?`, [spec.name])) {
      const v = unpack(row['vector'] as Uint8Array);
      const denominator = v.length === q.length ? qn * norm(v) : 0;
      // A row written by something other than this store can be unscorable:
      // skip it rather than fail every search (text search still finds its chunk).
      if (!Number.isFinite(denominator) || denominator <= 0) {
        continue;
      }
      let dot = 0;
      for (let i = 0; i < q.length; i++) {
        dot += q[i]! * v[i]!;
      }
      const score = dot / denominator;
      if (Number.isFinite(score)) {
        scores.push({ chunkId: String(row['chunk_id']), score });
      }
    }
    scores.sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1));

    return scores.slice(0, k);
  }

  async missing(spec: IndexSpec, chunkIds: readonly string[]): Promise<string[]> {
    this.assertPinned(spec, await this.fingerprintOf(spec.name));
    const ids = [...new Set(chunkIds)];
    if (ids.length === 0) {
      return [];
    }
    if (ids.length > 500) {
      throw new InvalidArgumentError('Pass at most 500 chunk ids per call.');
    }
    const have = new Set((await this.db.all(
      `SELECT chunk_id FROM ${this.vectors} WHERE index_name = ? AND chunk_id IN (${ids.map(() => '?').join(',')})`,
      [spec.name, ...ids],
    )).map((r) => String(r['chunk_id'])));

    return ids.filter((id) => !have.has(id));
  }

  async forget(chunkIds: readonly string[]): Promise<number> {
    const ids = [...new Set(chunkIds)];

    return this.db.atomic(async () => {
      let removed = 0;
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        removed += await this.db.run(`DELETE FROM ${this.vectors} WHERE chunk_id IN (${batch.map(() => '?').join(',')})`, batch);
      }

      return removed;
    });
  }

  private async fingerprintOf(name: string): Promise<string | null> {
    const row = (await this.db.all(`SELECT fingerprint FROM ${this.indexes} WHERE name = ?`, [name]))[0];

    return row === undefined ? null : String(row['fingerprint']);
  }

  private assertPinned(spec: IndexSpec, stored: string | null): void {
    if (stored === null) {
      throw new GraphError(`Index [${spec.name}] does not exist; call ensureIndex() first.`);
    }
    if (stored !== spec.fingerprint()) {
      throw new GraphError(`Index [${spec.name}] is pinned to a different embedder; vectors are never mixed.`);
    }
  }
}

function pack(vector: Float32Array): Uint8Array {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((x, i) => bytes.writeFloatLE(x, i * 4));

  return bytes;
}

function unpack(bytes: Uint8Array): Float32Array {
  const buffer = Buffer.from(bytes);
  const out = new Float32Array(Math.floor(buffer.length / 4));
  for (let i = 0; i < out.length; i++) {
    out[i] = buffer.readFloatLE(i * 4);
  }

  return out;
}

function norm(v: Float32Array): number {
  let sum = 0;
  for (const x of v) {
    sum += x * x;
  }

  return Math.sqrt(sum);
}

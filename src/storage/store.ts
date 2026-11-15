import { chunkId, type Chunk } from '../chunk.js';
import { GraphError, InvalidArgumentError } from '../errors.js';
import type { EraseReport, Fact } from '../fact.js';
import type { Scope } from '../scope.js';
import { FactStatus, isTrust, Trust, type AcceptancePolicy, type Origin } from '../trust.js';
import type { Row, SqlDriver, SqlValue } from './driver.js';
import { TableMap } from './schema.js';

export const MAX_QUERY_TERMS = 16;
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,6})?Z$/;
const KEY = /^[\x21-\x7E]{1,191}$/;

export interface StoredSource {
  readonly source: string;
  readonly stored: number;
  readonly retired: number;
}

interface PreparedFact {
  readonly from: string;
  readonly to: string | null;
  readonly evidence: string[];
  readonly status: FactStatus;
}

/**
 * Scoped memory storage over a SqlDriver, a port of the PHP reference's
 * PdoGraphStore. SCOPE IS PART OF EVERY QUERY: reads apply the visibility
 * predicate in SQL, so a row outside the reader's scope is never fetched.
 * Every write runs in driver.atomic(): all-or-nothing, including inside the
 * caller's own transaction.
 */
/** A source in a listing (G-282, contract g282.1). */
export interface ListedSource {
  readonly sourceId: string;
  readonly title: string;
  readonly kind: string | null;
  readonly createdAt: string;
  readonly chunkCount: number;
  readonly trust: string;
}

/** A chunk in a listing (G-282, contract g282.1). */
export interface ListedChunk {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly text: string;
  readonly position: number;
  readonly provenance: {
    readonly uri: string;
    readonly sha256: string;
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly headingPath: string[];
    readonly recipe: string;
    readonly trust: string;
    readonly writer: string;
    readonly recordedAt: string;
  };
}

/** A page of a listing. A consumer refuses a contractVersion it does not know. */
export interface ListingPage<T> {
  readonly contractVersion: 'g282.1';
  readonly items: T[];
  readonly nextCursor: string | null;
}

export class GraphStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly tables: TableMap = new TableMap(),
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Store a source and its verbatim chunks at `scope`, in ONE atomic block.
   * A source's trust is fixed when first stored: the upsert itself refuses a
   * different trust, so there is no read-then-write window.
   */
  async storeSource(scope: Scope, key: string, uri: string, sha256: string, metadata: Record<string, unknown>, origin: Origin, occurredAt: string | null, chunks: readonly Chunk[]): Promise<StoredSource> {
    assertKey(key);
    const id = scope.qualify('source', key);
    const occurred = occurredAt === null ? null : normaliseTime(occurredAt);

    return this.db.atomic(async () => {
      const written = await this.db.run(
        `INSERT INTO ${this.tables.sources}
         (id, source_key, tenant_id, owner_id, agent_id, thread_id, uri, sha256, metadata, trust, writer, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET uri = excluded.uri, sha256 = excluded.sha256, metadata = excluded.metadata,
            writer = excluded.writer, occurred_at = excluded.occurred_at
         WHERE ${this.tables.sources}.trust = excluded.trust`,
        [id, key, ...scope.toRow(), uri, sha256, JSON.stringify(metadata), origin.trust, origin.writer, occurred, this.now()],
      );
      if (written !== 1) {
        const stored = (await this.db.all(`SELECT trust FROM ${this.tables.sources} WHERE id = ?`, [id]))[0]?.['trust'] ?? 'unknown';
        throw new GraphError(`Source [${key}] was stored with trust [${String(stored)}]; trust cannot change. Erase it and ingest again.`);
      }

      let stored = 0;
      const keep: string[] = [];
      for (const chunk of chunks) {
        if (chunk.sourceId !== id) {
          throw new GraphError('A chunk belongs to a different source than the one being stored.');
        }
        if (chunkId(chunk.recipe, chunk.sourceId, chunk.byteStart, chunk.byteEnd, Buffer.from(chunk.text, 'utf8')) !== chunk.id) {
          throw new GraphError('A chunk id does not match its content; ids are content-addressed.');
        }
        if (chunk.byteStart < 0 || Buffer.byteLength(chunk.text, 'utf8') !== chunk.byteEnd - chunk.byteStart) {
          throw new GraphError('A chunk text must be exactly the bytes of its span.');
        }
        stored += await this.db.run(
          `INSERT INTO ${this.tables.chunks} (id, source_id, text, byte_start, byte_end, line_start, line_end, heading_path, recipe)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [chunk.id, chunk.sourceId, chunk.text, chunk.byteStart, chunk.byteEnd, chunk.lineStart, chunk.lineEnd, JSON.stringify(chunk.headingPath), chunk.recipe],
        );
        keep.push(chunk.id);
      }

      return { source: id, stored, retired: await this.retireExcept(id, keep) };
    });
  }

  /** Retire every chunk of a source stored at exactly `scope`. */
  async retireSource(scope: Scope, key: string): Promise<number> {
    return this.db.atomic(() => this.retireExcept(scope.qualify('source', key), []));
  }

  /** Chunks visible from `reader`, in the order asked. */
  async getChunks(reader: Scope, ids: readonly string[]): Promise<Chunk[]> {
    const wanted = [...new Set(ids.filter((id) => typeof id === 'string'))];
    const byId = new Map<string, Chunk>();
    for (const batch of batches(wanted, 500)) {
      const [visible, bindings] = this.visible('s', reader);
      const rows = await this.db.all(
        `SELECT c.*, s.source_key, s.trust FROM ${this.tables.chunks} c
         JOIN ${this.tables.sources} s ON s.id = c.source_id
         WHERE c.id IN (${marks(batch)}) AND ${visible}`,
        [...batch, ...bindings],
      );
      for (const row of rows) {
        byId.set(String(row['id']), toChunk(row));
      }
    }

    return wanted.map((id) => byId.get(id)).filter((c): c is Chunk => c !== undefined);
  }

  /**
   * Sources visible from `reader`, newest first, with at least one live chunk (G-282, contract g282.1). Rows are in
   * the agreed shape; the caller pages with `after` = [createdAt, sourceId] of the last item it returned.
   */
  async listSources(reader: Scope, after: readonly [string, string] | null, limit: number): Promise<ListedSource[]> {
    const [visible, bindings] = this.visible('s', reader);
    const live = `SELECT 1 FROM ${this.tables.chunks} c WHERE c.source_id = s.id AND c.retired_at IS NULL`;
    const page = after === null ? '' : ' AND (s.recorded_at < ? OR (s.recorded_at = ? AND s.id < ?))';
    const rows = await this.db.all(
      `SELECT s.id, s.uri, s.metadata, s.trust, s.recorded_at,
              (SELECT COUNT(*) FROM ${this.tables.chunks} c WHERE c.source_id = s.id AND c.retired_at IS NULL) AS chunk_count
       FROM ${this.tables.sources} s
       WHERE ${visible} AND EXISTS (${live})${page}
       ORDER BY s.recorded_at DESC, s.id DESC
       LIMIT ${Math.max(1, Math.min(1001, Math.trunc(limit)))}`,
      after === null ? bindings : [...bindings, after[0], after[0], after[1]],
    );

    return rows.map((row) => {
      let metadata: unknown;
      try { metadata = JSON.parse(String(row['metadata'])); } catch { metadata = {}; }
      const meta = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>) : {};
      const title = typeof meta['title'] === 'string' && meta['title'] !== '' ? meta['title'] : String(row['uri']);
      const kind = typeof meta['kind'] === 'string' && meta['kind'] !== '' ? meta['kind'] : null;

      return {
        sourceId: String(row['id']).trim(),
        title,
        kind,
        createdAt: String(row['recorded_at']).trim(),
        chunkCount: Number(row['chunk_count']),
        trust: String(row['trust']),
      };
    });
  }

  /** Live chunks of one source visible from `reader`, in source order. A source outside the scope yields nothing. */
  async listChunks(reader: Scope, sourceId: string, afterSeq: number | null, limit: number): Promise<Array<ListedChunk & { seq: number }>> {
    const [visible, bindings] = this.visible('s', reader);
    const rows = await this.db.all(
      `SELECT * FROM (
         SELECT c.seq, c.id, c.source_id, c.text, c.byte_start, c.byte_end, c.line_start, c.line_end,
                c.heading_path, c.recipe, s.uri, s.sha256, s.trust, s.writer, s.recorded_at,
                ROW_NUMBER() OVER (ORDER BY c.seq) AS position
         FROM ${this.tables.chunks} c
         JOIN ${this.tables.sources} s ON s.id = c.source_id
         WHERE c.source_id = ? AND c.retired_at IS NULL AND ${visible}
       ) listed WHERE listed.seq > ? ORDER BY listed.seq LIMIT ${Math.max(1, Math.min(1001, Math.trunc(limit)))}`,
      [sourceId, ...bindings, afterSeq ?? 0],
    );

    return rows.map((row) => ({
      chunkId: String(row['id']).trim(),
      sourceId: String(row['source_id']).trim(),
      text: String(row['text']),
      position: Number(row['position']),
      seq: Number(row['seq']),
      provenance: {
        uri: String(row['uri']),
        sha256: String(row['sha256']).trim(),
        byteStart: Number(row['byte_start']),
        byteEnd: Number(row['byte_end']),
        lineStart: Number(row['line_start']),
        lineEnd: Number(row['line_end']),
        headingPath: JSON.parse(String(row['heading_path'])) as string[],
        recipe: String(row['recipe']),
        trust: String(row['trust']),
        writer: String(row['writer']),
        recordedAt: String(row['recorded_at']).trim(),
      },
    }));
  }

  /** Full-text search over live chunks visible from `reader`, best first. */
  async textSearch(reader: Scope, query: string, limit: number): Promise<Array<{ chunkId: string; score: number }>> {
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== ''))].slice(0, MAX_QUERY_TERMS);
    if (terms.length === 0) {
      return [];
    }
    const [visible, bindings] = this.visible('s', reader);
    const fts = this.tables.fts();
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.trunc(limit))) : 1;
    const rows = await this.db.all(
      `SELECT c.id AS chunk_id, -bm25(${fts}) AS score
       FROM ${fts} JOIN ${this.tables.chunks} c ON c.seq = ${fts}.rowid
       JOIN ${this.tables.sources} s ON s.id = c.source_id
       WHERE ${fts} MATCH ? AND c.retired_at IS NULL AND ${visible}
       ORDER BY score DESC, c.id LIMIT ${bounded}`,
      [ftsMatch(terms), ...bindings],
    );

    return rows.map((r) => ({ chunkId: String(r['chunk_id']), score: Number(r['score']) }));
  }

  async assertFact(scope: Scope, fact: Fact, policy: AcceptancePolicy): Promise<Fact> {
    return this.db.atomic(async () => this.writeFact(scope, fact, await this.prepareFact(scope, fact, policy)));
  }

  /**
   * The world changed: close `oldKey`'s valid time and record the replacement.
   * The overwrite guard decides BEFORE any write: an accepted fact is closed
   * only for a replacement the policy also accepts, in the same statement.
   */
  async supersede(scope: Scope, oldKey: string, replacement: Fact, policy: AcceptancePolicy): Promise<Fact> {
    return this.db.atomic(async () => {
      const prepared = await this.prepareFact(scope, replacement, policy);
      const oldId = scope.qualify('fact', oldKey);
      const closed = await this.db.run(
        `UPDATE ${this.tables.facts} SET valid_to = ?, superseded_by = ?
         WHERE id = ? AND valid_to IS NULL AND expired_at IS NULL AND valid_from <= ?
           AND (status <> ? OR ? = ?)`,
        [prepared.from, replacement.id, oldId, prepared.from, FactStatus.Accepted, prepared.status, FactStatus.Accepted],
      );
      if (closed !== 1) {
        const old = (await this.db.all(`SELECT status, valid_to, expired_at FROM ${this.tables.facts} WHERE id = ?`, [oldId]))[0];
        if (old !== undefined && old['valid_to'] === null && old['expired_at'] === null
          && old['status'] === FactStatus.Accepted && prepared.status !== FactStatus.Accepted) {
          throw new GraphError(`An accepted fact can only be superseded by one the policy also accepts; this replacement would be a ${prepared.status}.`);
        }
        throw new GraphError('Only a fact still in force, valid before the replacement starts, can be superseded.');
      }

      return this.writeFact(scope, replacement, prepared);
    });
  }

  /**
   * We were wrong: end the fact's RECORDED time. An app decision, never a
   * tool: it does not check the acceptance policy, so retract-then-assert can
   * replace an accepted fact with weaker evidence; use supersede() to record
   * that the world changed.
   */
  async retract(scope: Scope, key: string): Promise<void> {
    const changed = await this.db.atomic(() => this.db.run(
      `UPDATE ${this.tables.facts} SET expired_at = ? WHERE id = ? AND expired_at IS NULL`,
      [this.now(), scope.qualify('fact', key)],
    ));
    if (changed !== 1) {
      throw new GraphError(`No current fact [${key}] at this scope to retract.`);
    }
  }

  /** An app decision: a proposed fact still in force becomes accepted. */
  async accept(scope: Scope, key: string): Promise<void> {
    const changed = await this.db.atomic(() => this.db.run(
      `UPDATE ${this.tables.facts} SET status = ? WHERE id = ? AND status = ? AND expired_at IS NULL AND valid_to IS NULL`,
      [FactStatus.Accepted, scope.qualify('fact', key), FactStatus.Proposed],
    ));
    if (changed !== 1) {
      throw new GraphError(`No proposed fact [${key}] at this scope to accept.`);
    }
  }

  async facts(reader: Scope, subject: string, options: { at?: string | null; knownAt?: string | null; unaccepted?: boolean } = {}): Promise<Fact[]> {
    const [visible, bindings] = this.visible('f', reader);
    const where = ['f.subject = ?', visible];
    const values: SqlValue[] = [subject, ...bindings];
    if (options.at == null) {
      where.push('f.valid_to IS NULL');
    } else {
      const at = normaliseTime(options.at);
      where.push('f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to > ?)');
      values.push(at, at);
    }
    if (options.knownAt == null) {
      where.push('f.expired_at IS NULL');
    } else {
      const known = normaliseTime(options.knownAt);
      where.push('f.recorded_at <= ? AND (f.expired_at IS NULL OR f.expired_at > ?)');
      values.push(known, known);
    }
    if (options.unaccepted !== true) {
      where.push('f.status = ?');
      values.push(FactStatus.Accepted);
    }
    const rows = await this.db.all(`SELECT f.* FROM ${this.tables.facts} f WHERE ${where.join(' AND ')} ORDER BY f.valid_from, f.fact_key`, values);

    return Promise.all(rows.map((row) => this.toFact(row)));
  }

  /** Every version of every fact about `subject` visible from `reader`, oldest first. */
  async timeline(reader: Scope, subject: string): Promise<Fact[]> {
    const [visible, bindings] = this.visible('f', reader);
    const rows = await this.db.all(
      `SELECT f.* FROM ${this.tables.facts} f WHERE f.subject = ? AND ${visible} ORDER BY f.valid_from, f.recorded_at, f.fact_key`,
      [subject, ...bindings],
    );

    return Promise.all(rows.map((row) => this.toFact(row)));
  }

  /** Erase a source stored at exactly `scope`: its chunks, their evidence links, and every fact left with no evidence. */
  async eraseSource(scope: Scope, key: string): Promise<EraseReport> {
    return this.db.atomic(async () => {
      const sourceId = scope.qualify('source', key);
      if ((await this.db.all(`SELECT id FROM ${this.tables.sources} WHERE id = ?`, [sourceId])).length === 0) {
        return { sourceFound: false, chunks: 0, evidenceLinks: 0, factsErased: 0, factsKept: 0, vectors: 0, chunkIds: [] };
      }
      const chunkIds = (await this.db.all(`SELECT id FROM ${this.tables.chunks} WHERE source_id = ?`, [sourceId])).map((r) => String(r['id']));
      let links = 0;
      const affected = new Set<string>();
      for (const batch of batches(chunkIds, 500)) {
        for (const row of await this.db.all(`SELECT DISTINCT fact_id FROM ${this.tables.evidence} WHERE chunk_id IN (${marks(batch)})`, batch)) {
          affected.add(String(row['fact_id']));
        }
        links += await this.db.run(`DELETE FROM ${this.tables.evidence} WHERE chunk_id IN (${marks(batch)})`, batch);
      }
      let erased = 0;
      let kept = 0;
      for (const batch of batches([...affected], 500)) {
        const orphans = (await this.db.all(
          `SELECT f.id FROM ${this.tables.facts} f WHERE f.id IN (${marks(batch)})
           AND NOT EXISTS (SELECT 1 FROM ${this.tables.evidence} e WHERE e.fact_id = f.id)`,
          batch,
        )).map((r) => String(r['id']));
        if (orphans.length > 0) {
          erased += await this.db.run(`DELETE FROM ${this.tables.facts} WHERE id IN (${marks(orphans)})`, orphans);
        }
        kept += batch.length - orphans.length;
      }
      const chunks = await this.db.run(`DELETE FROM ${this.tables.chunks} WHERE source_id = ?`, [sourceId]);
      await this.db.run(`DELETE FROM ${this.tables.sources} WHERE id = ?`, [sourceId]);

      return { sourceFound: true, chunks, evidenceLinks: links, factsErased: erased, factsKept: kept, vectors: 0, chunkIds };
    });
  }

  /** Validate a fact and decide its status, READING ONLY. */
  private async prepareFact(scope: Scope, fact: Fact, policy: AcceptancePolicy): Promise<PreparedFact> {
    assertKey(fact.id);
    const from = normaliseTime(fact.validFrom);
    const to = fact.validTo == null ? null : normaliseTime(fact.validTo);
    if (to !== null && to < from) {
      throw new GraphError('A fact cannot end before it starts.');
    }
    if (fact.supersededBy != null || fact.status != null || fact.recordedAt != null || fact.expiredAt != null) {
      throw new GraphError('Status, recorded times and superseded_by are set by the store, never asserted.');
    }
    const evidence = [...new Set(fact.evidence)];
    if (evidence.length === 0) {
      throw new GraphError('A fact must cite at least one chunk as evidence.');
    }
    // Evidence must be visible from the FACT's scope: a tenant-wide fact can
    // never cite one person's private thread.
    const chunks = await this.getChunks(scope, evidence);
    if (chunks.length !== evidence.length) {
      throw new GraphError("Every evidence id must name a stored chunk visible from the fact's scope.");
    }
    if (chunks.some((c) => c.retiredAt != null)) {
      throw new GraphError('A retired chunk cannot be cited as new evidence.');
    }

    return { from, to, evidence, status: policy.decide(chunks.map((c) => c.trust ?? Trust.System)) };
  }

  private async writeFact(scope: Scope, fact: Fact, prepared: PreparedFact): Promise<Fact> {
    const now = this.now();
    const id = scope.qualify('fact', fact.id);
    await this.db.run(
      `INSERT INTO ${this.tables.facts}
       (id, fact_key, tenant_id, owner_id, agent_id, thread_id, subject, predicate, object, status, valid_from, valid_to, superseded_by, recorded_at, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      [id, fact.id, ...scope.toRow(), fact.subject, fact.predicate, fact.object, prepared.status, prepared.from, prepared.to, now],
    );
    for (const chunk of prepared.evidence) {
      await this.db.run(`INSERT INTO ${this.tables.evidence} (fact_id, chunk_id) VALUES (?, ?)`, [id, chunk]);
    }

    return { ...fact, evidence: prepared.evidence, validFrom: prepared.from, validTo: prepared.to, supersededBy: null, status: prepared.status, recordedAt: now, expiredAt: null };
  }

  private async retireExcept(sourceId: string, keep: readonly string[]): Promise<number> {
    await this.db.run(`UPDATE ${this.tables.chunks} SET retired_at = ? WHERE source_id = ? AND retired_at IS NULL`, [this.now(), sourceId]);
    for (const batch of batches([...new Set(keep)], 500)) {
      await this.db.run(`UPDATE ${this.tables.chunks} SET retired_at = NULL WHERE source_id = ? AND id IN (${marks(batch)})`, [sourceId, ...batch]);
    }

    return Number((await this.db.all(`SELECT COUNT(*) AS n FROM ${this.tables.chunks} WHERE source_id = ? AND retired_at IS NOT NULL`, [sourceId]))[0]?.['n'] ?? 0);
  }

  /** The visibility predicate for a reader, over a table aliased `alias` carrying the scope columns. */
  private visible(alias: string, reader: Scope): [string, SqlValue[]] {
    return [
      `${alias}.tenant_id = ?`
      + ` AND (${alias}.owner_id IS NULL OR ${alias}.owner_id = ?)`
      + ` AND (${alias}.agent_id IS NULL OR ${alias}.agent_id = ?)`
      + ` AND (${alias}.thread_id IS NULL OR ${alias}.thread_id = ?)`,
      reader.toRow(),
    ];
  }

  private async toFact(row: Row): Promise<Fact> {
    const evidence = (await this.db.all(`SELECT chunk_id FROM ${this.tables.evidence} WHERE fact_id = ? ORDER BY chunk_id`, [String(row['id'])]))
      .map((r) => String(r['chunk_id']));
    const opt = (v: unknown): string | null => (v == null ? null : String(v));

    return {
      id: String(row['fact_key']), subject: String(row['subject']), predicate: String(row['predicate']), object: String(row['object']),
      evidence, validFrom: String(row['valid_from']), validTo: opt(row['valid_to']), supersededBy: opt(row['superseded_by']),
      status: String(row['status']) as FactStatus, recordedAt: String(row['recorded_at']), expiredAt: opt(row['expired_at']),
    };
  }

  private now(): string {
    return normaliseTime(this.clock());
  }
}

/**
 * An FTS5 MATCH expression in which every term is a quoted string (inner quotes
 * doubled): a literal, never an operator, column filter or prefix. ORed, so
 * BM25 ranks partial matches instead of dropping them.
 */
export function ftsMatch(terms: readonly string[]): string {
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

/**
 * Validate a UTC ISO 8601 time and return it in ONE fixed-width form
 * (microseconds, Z), identical to the PHP reference, so stored times compare
 * correctly as strings whatever precision they were given in.
 */
export function normaliseTime(value: string): string {
  const match = TIME.exec(value);
  if (match === null) {
    throw new InvalidArgumentError('Times must be UTC ISO 8601, e.g. 2026-11-14T00:00:00Z.');
  }
  const base = match[1]!;
  const parsed = new Date(`${base}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== base) {
    throw new InvalidArgumentError('Times must name a real UTC date and time.');
  }

  return `${base}.${(match[2] ?? '.').slice(1).padEnd(6, '0')}Z`;
}

function assertKey(key: string): void {
  if (!KEY.test(key)) {
    throw new InvalidArgumentError('Keys are 1-191 printable ASCII characters with no spaces.');
  }
}

function marks(values: readonly unknown[]): string {
  return values.map(() => '?').join(',');
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }

  return out;
}

function toChunk(row: Row): Chunk {
  const trust = row['trust'] == null ? null : String(row['trust']);

  return {
    id: String(row['id']),
    sourceId: String(row['source_id']),
    text: String(row['text']),
    byteStart: Number(row['byte_start']),
    byteEnd: Number(row['byte_end']),
    lineStart: Number(row['line_start']),
    lineEnd: Number(row['line_end']),
    headingPath: JSON.parse(String(row['heading_path'])) as string[],
    recipe: String(row['recipe']),
    retiredAt: row['retired_at'] == null ? null : String(row['retired_at']),
    sourceKey: row['source_key'] == null ? null : String(row['source_key']),
    trust: trust !== null && isTrust(trust) ? trust : null,
  };
}

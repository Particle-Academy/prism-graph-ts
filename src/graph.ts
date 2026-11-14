import type { Chunk, Chunker } from './chunk.js';
import { sha256 } from './digest.js';
import { GraphError, InvalidArgumentError } from './errors.js';
import type { EraseReport, Fact, IngestReport } from './fact.js';
import { IndexSpec } from './index-spec.js';
import type { Scope } from './scope.js';
import type { GraphStore } from './storage/store.js';
import { DefaultAcceptancePolicy, type AcceptancePolicy, type Origin } from './trust.js';
import type { Embedder, VectorStore } from './vectors.js';

export interface Hit {
  readonly chunk: Chunk;
  readonly score: number;
  /** "text", the vector store's method, or "hybrid" when both found it. */
  readonly method: string;
}

/**
 * Long-term memory for agents. This object only holds the wiring (store,
 * optional vectors and embedder, acceptance policy); it has NO read or write
 * methods of its own. Everything goes through a scope, so an unscoped query
 * cannot be written, by an app or by a model.
 */
export class Graph {
  constructor(
    private readonly store: GraphStore,
    private readonly vectors: VectorStore | null = null,
    private readonly embedder: Embedder | null = null,
    private readonly policy: AcceptancePolicy = new DefaultAcceptancePolicy(),
  ) {
    if ((vectors === null) !== (embedder === null)) {
      throw new InvalidArgumentError('Configure a VectorStore and an Embedder together, or neither.');
    }
  }

  scope(scope: Scope): ScopedGraph {
    return new ScopedGraph(scope, this.store, this.vectors, this.embedder, this.policy);
  }
}

/**
 * Memory as seen from one scope. Reads return what this scope can see (its own
 * rows and those shared from wider scopes above it); writes land at exactly
 * this scope. Nothing here widens a write.
 */
export class ScopedGraph {
  static readonly MAX_LIMIT = 200;
  /** A query goes to the embedding provider and the full-text index, so it is bounded. */
  static readonly MAX_QUERY_BYTES = 4096;
  static readonly MAX_GET_IDS = 1000;
  private static readonly RRF_K = 60;

  constructor(
    private readonly memoryScope: Scope,
    private readonly store: GraphStore,
    private readonly vectors: VectorStore | null,
    private readonly embedder: Embedder | null,
    private readonly policy: AcceptancePolicy,
  ) {}

  scope(): Scope {
    return this.memoryScope;
  }

  /**
   * Store a source and its verbatim chunks at this scope. Idempotent per key:
   * unchanged text stores and embeds nothing new; text the source no longer
   * contains is retired from search. Verbatim is stored first and never waits
   * on embedding; a failed embedding heals on the next ingest.
   */
  async ingest(key: string, uri: string, text: string, chunker: Chunker, origin: Origin, options: { metadata?: Record<string, unknown>; sha256?: string; occurredAt?: string } = {}): Promise<IngestReport> {
    const actual = sha256(Buffer.from(text, 'utf8'));
    if (options.sha256 !== undefined && options.sha256.toLowerCase() !== actual) {
      throw new GraphError(`The provided sha256 for [${key}] does not match its text.`);
    }
    const chunks = chunker.chunk(this.memoryScope.qualify('source', key), text);
    const { stored, retired } = await this.store.storeSource(this.memoryScope, key, uri, actual, options.metadata ?? {}, origin, options.occurredAt ?? null, chunks);

    if (this.vectors !== null && this.embedder !== null && chunks.length > 0) {
      const spec = this.spec();
      await this.vectors.ensureIndex(spec);
      const byId = new Map(chunks.map((c) => [c.id, c]));
      const ids = [...byId.keys()];
      for (let i = 0; i < ids.length; i += 500) {
        const todo = await this.vectors.missing(spec, ids.slice(i, i + 500));
        if (todo.length === 0) {
          continue;
        }
        const vectors = await this.embedder.embed(todo.map((id) => byId.get(id)!.text));
        if (vectors.length !== todo.length) {
          throw new GraphError('The embedder returned a different number of vectors than chunks.');
        }
        await this.vectors.upsert(spec, new Map(todo.map((id, n) => [id, vectors[n]!])));
        // An erase that ran while the provider was embedding has already removed
        // these chunks; erased text must not live on as an embedding.
        const present = new Set((await this.store.getChunks(this.memoryScope, todo)).map((c) => c.id));
        const gone = todo.filter((id) => !present.has(id));
        if (gone.length > 0) {
          await this.vectors.forget(gone);
        }
      }
    }

    return { source: key, sha256: actual, recipe: chunker.recipe(), chunks: chunks.length, stored, retired };
  }

  /** Take a source at this scope out of search; it stays readable by id. */
  async retireSource(key: string): Promise<number> {
    return this.store.retireSource(this.memoryScope, key);
  }

  /** Erase a source stored at this scope: chunks, vectors, evidence links and orphaned facts. */
  async erase(key: string): Promise<EraseReport> {
    const report = await this.store.eraseSource(this.memoryScope, key);
    if (this.vectors === null || report.chunkIds.length === 0) {
      return report;
    }

    return { ...report, vectors: await this.vectors.forget(report.chunkIds) };
  }

  async get(chunkIds: readonly string[]): Promise<Chunk[]> {
    if (chunkIds.length > ScopedGraph.MAX_GET_IDS) {
      throw new InvalidArgumentError(`Pass at most ${ScopedGraph.MAX_GET_IDS} chunk ids.`);
    }

    return this.store.getChunks(this.memoryScope, chunkIds);
  }

  /**
   * Hybrid search over what this scope can see: full-text (BM25) and, when
   * configured and `vectors` is true, vectors, fused by reciprocal rank. A
   * chunk with no vector yet still ranks through text.
   */
  async search(query: string, limit = 10, vectors = true): Promise<Hit[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > ScopedGraph.MAX_LIMIT) {
      throw new InvalidArgumentError(`limit must be between 1 and ${ScopedGraph.MAX_LIMIT}.`);
    }
    if (Buffer.byteLength(query, 'utf8') > ScopedGraph.MAX_QUERY_BYTES) {
      throw new InvalidArgumentError(`A query may be at most ${ScopedGraph.MAX_QUERY_BYTES} bytes.`);
    }
    if (!query.isWellFormed()) {
      throw new InvalidArgumentError('A query must be valid UTF-8.');
    }

    const lists = new Map<string, string[]>([['text', (await this.store.textSearch(this.memoryScope, query, limit * 3)).map((r) => r.chunkId)]]);
    if (vectors && this.vectors !== null && this.embedder !== null && query.trim() !== '') {
      const embedded = (await this.embedder.embed([query]))[0]!;
      lists.set(this.vectors.method(), (await this.vectors.nearest(this.spec(), embedded, Math.min(1000, limit * 10))).map((r) => r.chunkId));
    }

    const fused = new Map<string, number>();
    const methods = new Map<string, string[]>();
    for (const [method, ids] of lists) {
      ids.forEach((id, rank) => {
        fused.set(id, (fused.get(id) ?? 0) + 1 / (ScopedGraph.RRF_K + rank + 1));
        methods.set(id, [...(methods.get(id) ?? []), method]);
      });
    }
    if (fused.size === 0) {
      return [];
    }
    // Visibility and retirement are applied by the store, in SQL.
    const chunks = (await this.store.getChunks(this.memoryScope, [...fused.keys()])).filter((c) => c.retiredAt == null);

    return chunks
      .map((chunk) => ({ chunk, score: fused.get(chunk.id)!, method: methods.get(chunk.id)!.length > 1 ? 'hybrid' : methods.get(chunk.id)![0]! }))
      .sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1))
      .slice(0, limit);
  }

  async facts(subject: string, options: { at?: string | null; knownAt?: string | null; unaccepted?: boolean } = {}): Promise<Fact[]> {
    return this.store.facts(this.memoryScope, subject, options);
  }

  async timeline(subject: string): Promise<Fact[]> {
    return this.store.timeline(this.memoryScope, subject);
  }

  /** Store a fact at this scope; its status comes from the acceptance policy. */
  async assert(fact: Fact): Promise<Fact> {
    return this.store.assertFact(this.memoryScope, fact, this.policy);
  }

  async supersede(oldKey: string, replacement: Fact): Promise<Fact> {
    return this.store.supersede(this.memoryScope, oldKey, replacement, this.policy);
  }

  /** An app decision, never a tool. */
  async retract(key: string): Promise<void> {
    return this.store.retract(this.memoryScope, key);
  }

  /** An app decision, never a tool: a proposed fact becomes accepted. */
  async accept(key: string): Promise<void> {
    return this.store.accept(this.memoryScope, key);
  }

  /** The vector index for this tenant: another tenant's vectors can neither crowd nor appear in its results. */
  private spec(): IndexSpec {
    const base = this.embedder!.spec();

    return new IndexSpec(`${base.name.slice(0, 80)}.t${sha256(this.memoryScope.tenant).slice(0, 16)}`, base.provider, base.model, base.dimensions, base.recipe);
  }
}

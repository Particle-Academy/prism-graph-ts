import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

/**
 * The SQL the stores need, and nothing else. Every value is a bound
 * parameter ("?" placeholders); table names come only from a validated
 * TableMap.
 *
 * `atomic()` is all-or-nothing INCLUDING inside a caller's own transaction:
 * the work runs in a SAVEPOINT, so a refusal or failure rolls back exactly
 * prism-graph's work and leaves the caller's transaction usable. (The PHP
 * reference had to learn this the hard way: see its 0.2.1 notes.)
 */
export interface SqlDriver {
  readonly dialect: 'sqlite';
  run(sql: string, params?: readonly SqlValue[]): Promise<number>;
  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
  atomic<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * SQLite through Node's built-in node:sqlite (Node 22.13+): no native module,
 * no third-party dependency. Needs SQLite with FTS5, which node:sqlite has.
 *
 * Atomic blocks are SERIALISED on the connection. node:sqlite is synchronous,
 * but the store's work is async, and two interleaved blocks on one connection
 * would otherwise nest each other's savepoints.
 */
export class NodeSqliteDriver implements SqlDriver {
  readonly dialect = 'sqlite' as const;
  private queue: Promise<unknown> = Promise.resolve();
  private depth = 0;
  /** Set only inside an atomic block's own async context, so nesting is detected per call chain. */
  private readonly inside = new AsyncLocalStorage<true>();

  constructor(private readonly db: DatabaseSync) {}

  async run(sql: string, params: readonly SqlValue[] = []): Promise<number> {
    return Number(this.db.prepare(sql).run(...params.map(bind)).changes);
  }

  async all(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
    return this.db.prepare(sql).all(...params.map(bind)) as Row[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  atomic<T>(work: () => Promise<T>): Promise<T> {
    // Re-entrant: a block opened INSIDE another (same async call chain) runs
    // inline, in its own savepoint. Any other caller waits its turn.
    if (this.inside.getStore() === true) {
      return this.savepoint(work);
    }
    const result = this.queue.then(() => this.savepoint(work));
    this.queue = result.catch(() => undefined);

    return result;
  }

  private async savepoint<T>(work: () => Promise<T>): Promise<T> {
    // In SQLite a SAVEPOINT outside a transaction opens one, and RELEASE
    // commits it; inside the caller's transaction it nests. One rule for both.
    const name = `prism_graph_sp_${++this.depth}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = await this.inside.run(true, work);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);

      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally {
      this.depth--;
    }
  }
}

function bind(value: SqlValue): SqlValue {
  return value === undefined ? null : value;
}

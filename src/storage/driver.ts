import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { GraphError } from '../errors.js';

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

/** One open atomic block: nested blocks queue on it, and nothing joins it once it has closed. */
interface Block {
  queue: Promise<unknown>;
  open: boolean;
}

/**
 * SQLite through Node's built-in node:sqlite (Node 22.16+): no native module,
 * no third-party dependency. Needs SQLite with FTS5, which node:sqlite has.
 *
 * GIVE IT A CONNECTION OF ITS OWN, or route every write on that connection
 * through `atomic()`. SQLite transactions belong to the connection: a write
 * another part of the app makes while one of our blocks is open lands inside
 * our savepoint, and is rolled back with it if our block fails.
 *
 * Atomic blocks are serialised on the connection. A block opened inside
 * another (the same async call chain) queues inside its parent; a callback
 * that outlives its block (a timer, an un-awaited promise) is treated as a
 * new caller, never as part of a block that has already closed.
 */
export class NodeSqliteDriver implements SqlDriver {
  readonly dialect = 'sqlite' as const;
  private queue: Promise<unknown> = Promise.resolve();
  /** Only ever increases: savepoint names are unique for the life of the driver. */
  private counter = 0;
  private readonly inside = new AsyncLocalStorage<Block>();

  constructor(private readonly db: DatabaseSync) {
    if (typeof (db as { isTransaction?: unknown }).isTransaction !== 'boolean') {
      // Without it, a failed commit cannot be told apart from a caller's own
      // transaction, and a stuck connection would silently lose later writes.
      throw new GraphError('prism-graph needs node:sqlite with DatabaseSync.isTransaction (Node 22.16+).');
    }
  }

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
    const parent = this.inside.getStore();
    if (parent?.open === true) {
      // Nested in an open block: run inside it, one nested block at a time.
      const result = parent.queue.then(() => this.savepoint(work, false));
      parent.queue = result.catch(() => undefined);

      return result;
    }
    const result = this.queue.then(() => this.savepoint(work, true));
    this.queue = result.catch(() => undefined);

    return result;
  }

  private async savepoint<T>(work: () => Promise<T>, outermost: boolean): Promise<T> {
    // In SQLite a SAVEPOINT outside a transaction opens one, and RELEASE
    // commits it; inside the caller's transaction it nests. One rule for both.
    // Remember whether THIS block opened the transaction: only then may a
    // failure close it with a full ROLLBACK.
    const opened = outermost && !this.db.isTransaction;
    const name = `prism_graph_sp_${++this.counter}`;
    this.db.exec(`SAVEPOINT ${name}`);
    const block: Block = { queue: Promise.resolve(), open: true };
    let result: T;
    try {
      result = await this.inside.run(block, work);
      await block.queue; // nested blocks the work started but did not await
    } catch (error) {
      block.open = false;
      this.rollback(name, opened);
      throw error;
    }
    block.open = false;
    try {
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch (error) {
      // The commit itself failed (e.g. SQLITE_BUSY on the outermost RELEASE):
      // undo our work and never leave the connection inside a transaction,
      // where every later write would report success and be lost.
      this.rollback(name, opened);
      throw error;
    }

    return result;
  }

  private rollback(name: string, opened: boolean): void {
    try {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch {
      // Fall through: if we opened the transaction, close it below.
    }
    if (opened && this.db.isTransaction) {
      this.db.exec('ROLLBACK');
    }
  }
}

function bind(value: SqlValue): SqlValue {
  return value === undefined ? null : value;
}

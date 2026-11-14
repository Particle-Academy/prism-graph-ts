import { DatabaseSync } from 'node:sqlite';
import { Graph } from '../src/graph.js';
import { IndexSpec } from '../src/index-spec.js';
import { Scope } from '../src/scope.js';
import { NodeSqliteDriver } from '../src/storage/driver.js';
import { baseSchema, vectorSchema } from '../src/storage/schema.js';
import { GraphStore } from '../src/storage/store.js';
import { Origin, Trust } from '../src/trust.js';
import { SqliteVectorStore, type Embedder } from '../src/vectors.js';

export interface World {
  db: DatabaseSync;
  driver: NodeSqliteDriver;
  store: GraphStore;
  clock: { now: string };
  graph(withVectors?: Embedder): Graph;
}

export function world(): World {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of [...baseSchema(), ...vectorSchema()]) {
    db.exec(sql);
  }
  const driver = new NodeSqliteDriver(db);
  const clock = { now: '2026-01-01T00:00:00Z' };
  const store = new GraphStore(driver, undefined, () => clock.now);

  return {
    db, driver, store, clock,
    graph: (embedder?: Embedder) => embedder === undefined ? new Graph(store) : new Graph(store, new SqliteVectorStore(driver), embedder),
  };
}

export const user = (who = 'user-7'): Origin => new Origin(Trust.User, who);
export const tool = (): Origin => new Origin(Trust.Tool, 'tool:web_fetch');
export const agentWriter = (): Origin => new Origin(Trust.Agent, 'agent:support');
export const acme = (): Scope => Scope.tenant('acme');

/** A deterministic letter-count embedder. */
export function letters(dimensions = 3): Embedder & { seen: string[]; fail: boolean } {
  const embedder = {
    seen: [] as string[],
    fail: false,
    spec: () => new IndexSpec('main', 'test', 'letters', dimensions),
    async embed(texts: readonly string[]): Promise<number[][]> {
      if (embedder.fail) {
        throw new Error('embedding provider down');
      }
      embedder.seen.push(...texts);

      return texts.map((t) => ['a', 'e', 'o', 'i', 'u'].slice(0, dimensions).map((l) => 1 + t.toLowerCase().split(l).length - 1));
    },
  };

  return embedder;
}

export function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as Record<string, unknown>)['n']);
}

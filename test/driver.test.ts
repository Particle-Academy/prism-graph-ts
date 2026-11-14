import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowChunker } from '../src/chunking/window.js';
import { InvalidArgumentError } from '../src/errors.js';
import { Graph } from '../src/graph.js';
import { Scope } from '../src/scope.js';
import { NodeSqliteDriver } from '../src/storage/driver.js';
import { baseSchema } from '../src/storage/schema.js';
import { GraphStore } from '../src/storage/store.js';
import { memoryTools } from '../src/tools.js';
import { acme, user, world } from './fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the SQLite driver (security review of the TS port)', () => {
  // F1: a failed commit left the connection inside a transaction, and every
  // later write reported success and was lost.
  it('a failed commit never leaves the connection stuck in a transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-graph-'));
    dirs.push(dir);
    const file = join(dir, 'memory.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = DELETE');
    for (const sql of baseSchema()) {
      db.exec(sql);
    }
    const memory = new Graph(new GraphStore(new NodeSqliteDriver(db))).scope(Scope.tenant('t1').withOwner('o1'));
    const reader = new DatabaseSync(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM graph_sources').get(); // holds a SHARED lock

    await expect(memory.ingest('doc', 'u', 'Alice lives in Paris.', new WindowChunker(), user())).rejects.toThrow();
    expect(db.isTransaction, 'the writer must not be left inside a transaction').toBe(false);

    reader.exec('COMMIT');
    await memory.ingest('doc2', 'u', 'Bob lives in Rome.', new WindowChunker(), user());
    db.close();
    reader.close();
    const fresh = new DatabaseSync(file);
    expect(fresh.prepare('SELECT source_key FROM graph_sources').all().map((r) => (r as { source_key: string }).source_key)).toEqual(['doc2']);
    fresh.close();
  });

  it("an app's open transaction is never closed by a failing block", async () => {
    const w = world();
    const memory = w.graph().scope(acme().withOwner('alice'));
    w.db.exec('BEGIN');
    await expect(memory.ingest('k', 'u', 'x', new WindowChunker(), user(), { sha256: '0'.repeat(64) })).rejects.toThrow();
    await expect(memory.supersede('missing', { id: 'n', subject: 's', predicate: 'p', object: 'o', evidence: ['a'.repeat(64)], validFrom: '2026-01-01T00:00:00Z' })).rejects.toThrow();
    expect(w.db.isTransaction).toBe(true);
    w.db.exec('COMMIT');
  });

  // F3: concurrent nested blocks collided on savepoint names.
  it('concurrent nested blocks inside one block do not collide', async () => {
    const w = world();
    await w.driver.atomic(async () => {
      await Promise.all([1, 2, 3].map((n) => w.driver.atomic(() => w.driver.run('CREATE TABLE IF NOT EXISTS t (n)').then(() => w.driver.run('INSERT INTO t VALUES (?)', [n])))));
    });
    expect((w.db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(3);
  });

  // F3: a callback that outlives its block must not run inside another caller's savepoint.
  it('a detached callback is a new caller, not part of a closed block', async () => {
    const w = world();
    w.db.exec('CREATE TABLE log (n)');
    let late: Promise<unknown> = Promise.resolve();
    await w.driver.atomic(async () => {
      late = new Promise((resolve) => setTimeout(() => resolve(w.driver.atomic(() => w.driver.run('INSERT INTO log VALUES (1)'))), 5));
    });
    // Another caller's block fails while the late callback runs.
    const failing = w.driver.atomic(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('boom');
    });
    await late;
    await expect(failing).rejects.toThrow('boom');
    expect((w.db.prepare('SELECT COUNT(*) AS n FROM log').get() as { n: number }).n, 'the late write was rolled back with someone else').toBe(1);
  });

  it('refuses a node:sqlite without isTransaction rather than guessing', () => {
    expect(() => new NodeSqliteDriver({ prepare() {}, exec() {} } as unknown as DatabaseSync)).toThrow();
  });
});

describe('small hardening (security review of the TS port)', () => {
  // F5: reserved verbs hidden by a zero-width character or a homoglyph.
  it('a tool prefix must be plain ASCII', () => {
    const memory = world().graph().scope(acme().withOwner('a'));
    for (const prefix of ['con​firm_', 'аccept_', 'Memory_', 'a-b']) {
      expect(() => memoryTools(memory, 'agent:x', { prefix }), prefix).toThrow(InvalidArgumentError);
    }
    expect(memoryTools(memory, 'agent:x', { prefix: 'journal_' }).map((t) => t.name)).toContain('journal_search');
  });

  // F6: NaN reached the SQL as LIMIT NaN.
  it('a non-finite limit cannot reach the SQL', async () => {
    const w = world();
    await w.graph().scope(acme().withOwner('a')).ingest('d', 'u', 'owls\n', new WindowChunker(), user());
    expect(await w.store.textSearch(acme().withOwner('a'), 'owls', Number.NaN)).toHaveLength(1);
  });

  // F7: Scope(undefined) was accepted.
  it('scope ids must be strings', () => {
    expect(() => new Scope(undefined as unknown as string)).toThrow(InvalidArgumentError);
    expect(() => new Scope('t', 7 as unknown as string)).toThrow(InvalidArgumentError);
  });
});

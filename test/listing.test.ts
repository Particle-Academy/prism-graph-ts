import { describe, expect, it } from 'vitest';
import { MarkdownChunker } from '../src/chunking/markdown.js';
import { InvalidArgumentError } from '../src/errors.js';
import { Graph } from '../src/graph.js';
import { Scope } from '../src/scope.js';
import { tool, user, world } from './fixture.js';

/** G-282: scoped, paginated listing, in the shape agreed with Fancy (g282.1). Mirrors the PHP ListingTest. */
const md = () => new MarkdownChunker();
const aliceScope = () => Scope.tenant('acme').withOwner('alice');

describe('listing (G-282)', () => {
  it('lists sources newest first with the agreed fields', async () => {
    const w = world();
    const alice = w.graph().scope(aliceScope());
    w.clock.now = '2026-01-01T00:00:00Z';
    await alice.ingest('old', 'f://old', 'Old note.\n', md(), user('alice'), { metadata: { title: 'Old note', kind: 'note' } });
    w.clock.now = '2026-01-02T00:00:00Z';
    await alice.ingest('new', 'f://new', '# A\nOne.\n\n# B\nTwo.\n', md(), tool());

    const page = await alice.listSources();

    expect(page.contractVersion).toBe('g282.1');
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.title)).toEqual(['f://new', 'Old note']);
    expect(Object.keys(page.items[0]!)).toEqual(['sourceId', 'title', 'kind', 'createdAt', 'chunkCount', 'trust']);
    expect(page.items[0]).toMatchObject({ kind: null, trust: 'tool', chunkCount: 2 });
    expect(page.items[1]!.kind).toBe('note');
  });

  it('never lists another owner or tenant, and reads a foreign source id as empty', async () => {
    const w = world();
    const graph = w.graph();
    await graph.scope(aliceScope()).ingest('a', 'f://a', 'Alice private.\n', md(), user('alice'));
    await graph.scope(Scope.tenant('acme').withOwner('bob')).ingest('b', 'f://b', 'Bob private.\n', md(), user('bob'));
    await graph.scope(Scope.tenant('globex').withOwner('alice')).ingest('g', 'f://g', 'Other tenant.\n', md(), user('alice'));
    await graph.scope(Scope.tenant('acme')).ingest('shared', 'f://shared', 'Tenant-wide.\n', md(), user('admin'));

    const titles = (await graph.scope(aliceScope()).listSources()).items.map((i) => i.title).sort();
    expect(titles).toEqual(['f://a', 'f://shared']);

    const bobsId = (await graph.scope(Scope.tenant('acme').withOwner('bob')).listSources()).items[0]!.sourceId;
    expect((await graph.scope(aliceScope()).listChunks(bobsId)).items).toEqual([]);
  });

  it('pages through every source exactly once, across recorded_at ties', async () => {
    const w = world();
    const alice = w.graph().scope(aliceScope());
    for (let i = 1; i <= 7; i++) {
      w.clock.now = `2026-01-0${(i % 3) + 1}T00:00:00Z`;
      await alice.ingest(`s${i}`, `f://s${i}`, `Note ${i}.\n`, md(), user('alice'));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await alice.listSources(cursor, 3);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((i) => i.sourceId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen.length).toBe(7);
  });

  it('lists chunks in order with provenance, and pages', async () => {
    const w = world();
    const alice = w.graph().scope(aliceScope());
    await alice.ingest('doc', 'f://doc', '# A\nOne.\n\n# B\nTwo.\n\n# C\nThree.\n', md(), user('alice'));
    const sourceId = (await alice.listSources()).items[0]!.sourceId;

    const first = await alice.listChunks(sourceId, null, 2);
    expect(first.contractVersion).toBe('g282.1');
    expect(first.items.map((c) => c.position)).toEqual([1, 2]);
    expect(Object.keys(first.items[0]!)).toEqual(['chunkId', 'sourceId', 'text', 'position', 'provenance']);
    expect(first.items[0]!.provenance).toMatchObject({ uri: 'f://doc', trust: 'user', writer: 'alice', headingPath: ['A'] });
    expect(first.nextCursor).not.toBeNull();

    const second = await alice.listChunks(sourceId, first.nextCursor, 2);
    expect(second.items.map((c) => c.position)).toEqual([3]);
    expect(second.nextCursor).toBeNull();
  });

  it('excludes retired sources', async () => {
    const w = world();
    const alice = w.graph().scope(aliceScope());
    await alice.ingest('gone', 'f://gone', 'Retire me.\n', md(), user('alice'));
    await alice.ingest('kept', 'f://kept', 'Keep me.\n', md(), user('alice'));
    await alice.retireSource('gone');

    expect((await alice.listSources()).items.map((i) => i.title)).toEqual(['f://kept']);
  });

  it('refuses a cursor from another scope or listing, and a forged one', async () => {
    const w = world();
    const graph = w.graph();
    const alice = graph.scope(aliceScope());
    for (let i = 1; i <= 3; i++) {
      await alice.ingest(`s${i}`, `f://s${i}`, `Note ${i}.\n`, md(), user('alice'));
    }
    const cursor = (await alice.listSources(null, 1)).nextCursor!;
    const bob = graph.scope(Scope.tenant('acme').withOwner('bob'));
    const forged = Buffer.from(JSON.stringify({ k: ['x', 'y'], b: '0000000000000000' })).toString('base64url');

    for (const attempt of [
      () => bob.listSources(cursor),
      () => alice.listChunks('any', cursor),
      () => alice.listSources('not a cursor!'),
      () => alice.listSources(forged),
    ]) {
      await expect(attempt()).rejects.toThrow(new InvalidArgumentError('Invalid cursor.'));
    }
  });

  it('caps the page size, and the cap is configurable', async () => {
    const w = world();
    const alice = w.graph().scope(aliceScope());
    expect((await alice.listSources(null, 200)).items).toEqual([]);
    await expect(alice.listSources(null, 201)).rejects.toThrow(InvalidArgumentError);

    const small = new Graph(w.store, null, null, undefined, 5).scope(aliceScope());
    await expect(small.listSources(null, 6)).rejects.toThrow(InvalidArgumentError);
  });
});

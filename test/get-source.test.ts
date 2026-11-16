import { describe, expect, it, vi } from 'vitest';
import { MarkdownChunker } from '../src/chunking/markdown.js';
import { GraphError, InvalidArgumentError } from '../src/errors.js';
import { Graph } from '../src/graph.js';
import { Scope } from '../src/scope.js';
import { GraphStore } from '../src/storage/store.js';
import { user, world } from './fixture.js';

/** G-295: a scoped by-id source lookup, found iff listSources would list it. Mirrors the PHP GetSourceTest. */
const md = () => new MarkdownChunker();
const aliceScope = () => Scope.tenant('acme').withOwner('alice');
const bobScope = () => Scope.tenant('acme').withOwner('bob');

describe('getSource (G-295)', () => {
  it('never finds another owner, tenant or narrower scope, and says so exactly as for an unknown id', async () => {
    const w = world();
    const graph = w.graph();
    await graph.scope(aliceScope()).ingest('a', 'f://a', 'Alice private.\n', md(), user('alice'));
    await graph.scope(bobScope()).ingest('b', 'f://b', 'Bob private.\n', md(), user('bob'));
    await graph.scope(Scope.tenant('globex').withOwner('alice')).ingest('g', 'f://g', 'Other tenant.\n', md(), user('alice'));
    const alice = graph.scope(aliceScope());
    const bobsId = (await graph.scope(bobScope()).listSources()).items[0]!.sourceId;
    const globexId = (await graph.scope(Scope.tenant('globex').withOwner('alice')).listSources()).items[0]!.sourceId;
    const alicesId = (await alice.listSources()).items[0]!.sourceId;
    const absent = { contractVersion: 'g282.1', item: null };

    expect(await alice.getSource(bobsId)).toEqual(absent);
    expect(await alice.getSource(globexId)).toEqual(absent);
    // A wider scope does not see a narrower one's rows.
    expect(await graph.scope(Scope.tenant('acme')).getSource(alicesId)).toEqual(absent);
    expect(await alice.getSource('0'.repeat(64))).toEqual(absent);
  });

  it('finds exactly the item listSources lists, including one shared from a wider scope', async () => {
    const w = world();
    const graph = w.graph();
    const alice = graph.scope(aliceScope());
    await alice.ingest('doc', 'f://doc', '# A\nOne.\n\n# B\nTwo.\n', md(), user('alice'), { metadata: { title: 'Doc', kind: 'note' } });
    await graph.scope(Scope.tenant('acme')).ingest('shared', 'f://shared', 'Tenant-wide.\n', md(), user('admin'));

    const listed = (await alice.listSources()).items;
    expect(listed).toHaveLength(2);
    for (const item of listed) {
      const found = await alice.getSource(item.sourceId);
      expect(found.contractVersion).toBe('g282.1');
      expect(found.item).toStrictEqual(item);
      expect(Object.keys(found.item!)).toEqual(['sourceId', 'title', 'kind', 'createdAt', 'chunkCount', 'trust']);
    }
  });

  it('does not find a source whose every chunk is retired', async () => {
    const w = world();
    const alice = w.graph().scope(aliceScope());
    await alice.ingest('gone', 'f://gone', 'Retire me.\n', md(), user('alice'));
    const id = (await alice.listSources()).items[0]!.sourceId;
    await alice.retireSource('gone');

    expect((await alice.getSource(id)).item).toBeNull();
  });

  it('treats an injection attempt as an id, not SQL', async () => {
    const w = world();
    const alice = w.graph().scope(aliceScope());
    await alice.ingest('a', 'f://a', 'Alice private.\n', md(), user('alice'));
    await w.graph().scope(bobScope()).ingest('b', 'f://b', 'Bob private.\n', md(), user('bob'));

    for (const id of ["' OR 1=1 --", "x' OR '1'='1", '%', '*']) {
      expect((await alice.getSource(id)).item).toBeNull();
    }
  });

  it('refuses a malformed id before any store call', async () => {
    const w = world();
    const spy = vi.spyOn(w.store, 'findSource');
    const alice = w.graph().scope(aliceScope());

    for (const id of [undefined, null, 42, {}, ['x'], '', 'a'.repeat(256), 'é'.repeat(128), 'a\u0000b', 'a\nb', 'a\u007Fb', 'a\u0085b']) {
      await expect(alice.getSource(id as unknown as string)).rejects.toThrow(InvalidArgumentError);
    }
    expect(spy).not.toHaveBeenCalled();
    // The bound is bytes, not characters: 255 bytes is accepted.
    expect((await alice.getSource('a'.repeat(255))).item).toBeNull();
    expect((await alice.getSource('é'.repeat(127))).item).toBeNull();
  });

  it('refuses with a GraphError when the store lacks the capability, and listing still works', async () => {
    const w = world();
    class ListingOnlyStore extends GraphStore {}
    Object.defineProperty(ListingOnlyStore.prototype, 'findSource', { value: undefined });
    const store = new ListingOnlyStore(w.driver, undefined, () => w.clock.now);
    const alice = new Graph(store).scope(aliceScope());
    await alice.ingest('a', 'f://a', 'Alice private.\n', md(), user('alice'));
    const id = (await alice.listSources()).items[0]!.sourceId;

    await expect(alice.getSource(id)).rejects.toThrow(GraphError);
  });
});

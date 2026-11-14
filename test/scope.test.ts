import { describe, expect, it } from 'vitest';
import { MarkdownChunker } from '../src/chunking/markdown.js';
import { GraphError, InvalidArgumentError } from '../src/errors.js';
import { Scope } from '../src/scope.js';
import { memoryTools } from '../src/tools.js';
import { Origin, Trust } from '../src/trust.js';
import { acme, agentWriter, letters, user, world } from './fixture.js';

/** Adversarial: every test tries to cross a scope boundary and asserts it cannot. */
describe('scope isolation', () => {
  it('one tenant never reads another, by search or by id', async () => {
    const w = world();
    const graph = w.graph();
    await graph.scope(Scope.tenant('acme').withOwner('u1')).ingest('doc', 'f://d', "Acme's launch code is heron.\n", new MarkdownChunker(), user());
    const rival = graph.scope(Scope.tenant('globex').withOwner('u1'));

    expect(await rival.search('launch code heron')).toEqual([]);
    const id = (await graph.scope(Scope.tenant('acme').withOwner('u1')).search('heron'))[0]!.chunk.id;
    expect(await rival.get([id])).toEqual([]);
  });

  it('the same key in two tenants is two rows, not one overwritten', async () => {
    const w = world();
    const graph = w.graph();
    await graph.scope(Scope.tenant('acme').withOwner('u1')).ingest('doc', 'f://a', 'Acme text.\n', new MarkdownChunker(), user());
    await graph.scope(Scope.tenant('globex').withOwner('u1')).ingest('doc', 'f://g', 'Globex text.\n', new MarkdownChunker(), user());

    expect(await graph.scope(Scope.tenant('acme').withOwner('u1')).search('globex')).toEqual([]);
    expect((w.db.prepare('SELECT COUNT(*) AS n FROM graph_sources').get() as { n: number }).n).toBe(2);
  });

  it('owners are isolated and tenant-shared memory reaches all', async () => {
    const graph = world().graph();
    await graph.scope(acme()).ingest('policy', 'f://p', 'Refunds within thirty days.\n', new MarkdownChunker(), new Origin(Trust.Document, 'admin'));
    await graph.scope(acme().withOwner('alice')).ingest('diary', 'f://a', "Alice's allergy is peanuts.\n", new MarkdownChunker(), user('alice'));

    const bob = graph.scope(acme().withOwner('bob').withAgent('support').withThread('t9'));
    expect(await bob.search('refunds')).not.toEqual([]);
    expect(await bob.search('allergy peanuts')).toEqual([]);
  });

  it('threads and agents only see upward, never sideways', async () => {
    const graph = world().graph();
    const base = acme().withOwner('alice');
    await graph.scope(base.withAgent('support').withThread('t1')).ingest('m1', 'f://1', 'Thread one secret: kestrel.\n', new MarkdownChunker(), user('alice'));
    await graph.scope(base.withAgent('sales')).ingest('m2', 'f://2', 'Sales agent memory: falcon.\n', new MarkdownChunker(), agentWriter());

    expect(await graph.scope(base.withAgent('support').withThread('t2')).search('kestrel')).toEqual([]);
    expect(await graph.scope(base.withAgent('support')).search('kestrel')).toEqual([]);
    expect(await graph.scope(base.withAgent('support').withThread('t1')).search('falcon')).toEqual([]);
  });

  it('a scope that would be visible across owners cannot be built', () => {
    expect(() => new Scope('acme', null, 'support')).toThrow(InvalidArgumentError);
  });

  it('a fact cannot cite evidence its readers could not see', async () => {
    const graph = world().graph();
    const priv = graph.scope(acme().withOwner('alice').withAgent('support').withThread('t1'));
    await priv.ingest('m', 'f://m', 'Alice earns ninety thousand.\n', new MarkdownChunker(), user('alice'));
    const chunk = (await priv.search('earns'))[0]!.chunk;

    await expect(graph.scope(acme()).assert({ id: 'salary', subject: 'alice', predicate: 'earns', object: '90k', evidence: [chunk.id], validFrom: '2026-01-01T00:00:00Z' }))
      .rejects.toThrow(GraphError);
  });

  it('erase reaches only the scope it is called from', async () => {
    const graph = world().graph();
    await graph.scope(acme().withOwner('alice')).ingest('doc', 'f://a', "Alice's copy.\n", new MarkdownChunker(), user('alice'));
    await graph.scope(acme().withOwner('bob')).ingest('doc', 'f://b', "Bob's copy.\n", new MarkdownChunker(), user('bob'));

    expect((await graph.scope(acme().withOwner('bob')).erase('doc')).sourceFound).toBe(true);
    expect(await graph.scope(acme().withOwner('alice')).search('copy')).not.toEqual([]);
  });

  it("another tenant's vectors never crowd out or appear in results", async () => {
    const graph = world().graph(letters());
    for (let i = 0; i < 80; i++) {
      await graph.scope(Scope.tenant('globex').withOwner('u')).ingest(`g${i}`, 'f://g', `zzz ${i}\n`, new MarkdownChunker(), user());
    }
    await graph.scope(Scope.tenant('acme').withOwner('u')).ingest('a', 'f://a', 'zzz a\n', new MarkdownChunker(), user());

    const hits = await graph.scope(Scope.tenant('acme').withOwner('u')).search('zzz', 5);
    expect([...new Set(hits.map((h) => h.chunk.sourceKey))]).toEqual(['a']);
    expect(hits[0]!.method).toBe('hybrid');
  });

  it('memory tools cannot be steered out of their scope', async () => {
    const graph = world().graph();
    await graph.scope(acme().withOwner('alice')).ingest('d', 'f://d', "Alice's PIN is 4821.\n", new MarkdownChunker(), user('alice'));
    const id = (await graph.scope(acme().withOwner('alice')).search('pin'))[0]!.chunk.id;
    const tools = Object.fromEntries(memoryTools(graph.scope(acme().withOwner('bob').withAgent('support')), 'agent:support').map((t) => [t.name, t]));

    expect(JSON.parse(await tools['memory_search']!.call({ query: 'PIN 4821' })).results).toEqual([]);
    expect(JSON.parse(await tools['memory_get']!.call({ ids: id })).chunks).toEqual([]);
    expect(JSON.parse(await tools['memory_facts']!.call({ subject: 'alice', include_beliefs: true })).facts).toEqual([]);
  });
});

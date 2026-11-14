import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LoopbackHttpTransport, Server, ToolDefinition, type JsonObject } from '@particle-academy/prism-mcp-server';
import { MarkdownChunker } from '../src/chunking/markdown.js';
import type { ScopedGraph } from '../src/graph.js';
import { memoryTools } from '../src/tools.js';
import { acme, user, world } from './fixture.js';

/**
 * The mountable tool layer on a REAL MCP server (our own prism-mcp-server),
 * over loopback HTTP, through the full client exchange: initialize, tools/list,
 * tools/call. This is what an app with its own MCP server does.
 */
const transports: LoopbackHttpTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.map((t) => t.close()));
  transports.length = 0;
});

async function mount(memory: ScopedGraph, writer: string): Promise<{ url: string; token: string }> {
  const transport = new LoopbackHttpTransport();
  transports.push(transport);
  const server = new Server({ server: 'journal', transport });
  for (const tool of memoryTools(memory, writer)) {
    server.register(
      new ToolDefinition(tool.name, tool.description, tool.inputSchema as JsonObject),
      async (args) => ({ text: await tool.call(args), isError: false }),
    );
  }
  const endpoint = await server.listen();

  return { url: endpoint.url, token: endpoint.token as string };
}

let id = 0;
function send(url: string, token: string, body: JsonObject, headers: http.OutgoingHttpHeaders = {}): Promise<JsonObject> {
  const data = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}`, ...headers },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.once('end', () => resolve(text ? JSON.parse(text) as JsonObject : {}));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(data);
  });
}

const rpc = (method: string, params?: JsonObject): JsonObject => ({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) });
const HEADERS = { 'MCP-Protocol-Version': '2025-06-18' };

async function callTool(url: string, token: string, name: string, args: JsonObject): Promise<Record<string, unknown>> {
  const reply = await send(url, token, rpc('tools/call', { name, arguments: args }), HEADERS);
  const content = (reply['result'] as { content: Array<{ text: string }> }).content;

  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('memory tools on prism-mcp-server', () => {
  it('serve list and call over the real MCP exchange, inside their bound scope', async () => {
    const graph = world().graph();
    const alice = graph.scope(acme().withOwner('alice').withAgent('journal'));
    await alice.ingest('entry-1', 'journal://1', 'I am allergic to peanuts.\n', new MarkdownChunker(), user('alice'));
    const { url, token } = await mount(alice, 'agent:journal');

    await send(url, token, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    await send(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = ((await send(url, token, rpc('tools/list'), HEADERS))['result'] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools.sort()).toEqual(['memory_facts', 'memory_get', 'memory_note', 'memory_search', 'memory_timeline']);

    const found = await callTool(url, token, 'memory_search', { query: 'peanuts' });
    expect((found['results'] as Array<{ text: string; trust: string }>)[0]).toMatchObject({ text: 'I am allergic to peanuts.\n', trust: 'user' });

    const noted = await callTool(url, token, 'memory_note', { text: 'Suggest nut-free snacks.' });
    expect(noted['trust']).toBe('agent');
  });

  it("one person's mounted tools never reach another person's memory", async () => {
    const graph = world().graph();
    await graph.scope(acme().withOwner('alice').withAgent('journal')).ingest('pin', 'journal://p', "Alice's PIN is 4821.\n", new MarkdownChunker(), user('alice'));
    const { url, token } = await mount(graph.scope(acme().withOwner('bob').withAgent('journal')), 'agent:journal');

    expect((await callTool(url, token, 'memory_search', { query: 'PIN 4821' }))['results']).toEqual([]);
  });

  it('hostile arguments come back as errors, never as a protocol failure', async () => {
    const graph = world().graph();
    const { url, token } = await mount(graph.scope(acme().withOwner('alice').withAgent('journal')), 'agent:journal');

    expect(await callTool(url, token, 'memory_get', { ids: "x' OR 1=1 --" })).toHaveProperty('error');
    expect(await callTool(url, token, 'memory_search', { query: 'a '.repeat(5000) })).toHaveProperty('error');
  });
});

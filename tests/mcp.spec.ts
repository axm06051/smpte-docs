import { expect, test, type APIRequestContext } from '@playwright/test';

const token = process.env.MCP_TOKEN ?? '';
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function rpc(request: APIRequestContext, method: string, params: object = {}, id = 1) {
  const res = await request.post('/mcp', { headers, data: { jsonrpc: '2.0', id, method, params } });
  expect(res.status()).toBe(200);
  // Streamable HTTP replies as a single SSE "message" event (or plain JSON).
  const body = await res.text();
  const start = body.indexOf('data: ');
  const json = start >= 0 ? body.slice(start + 6).trim() : body;
  return JSON.parse(json);
}

const callTool = async (request: APIRequestContext, name: string, args: object) =>
  (await rpc(request, 'tools/call', { name, arguments: args })).result;

test('health endpoint', async ({ request }) => {
  expect(await (await request.get('/healthz')).text()).toBe('ok');
});

test('initialize and list tools', async ({ request }) => {
  const init = await rpc(request, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'playwright', version: '1' },
  });
  expect(init.result.serverInfo.name).toBe('SMPTE Search');

  const tools = (await rpc(request, 'tools/list')).result.tools.map(
    (t: { name: string }) => t.name,
  );
  expect(tools).toEqual(expect.arrayContaining(['search_smpte', 'read_smpte_document']));
});

test('search puts results in the text content the model sees', async ({ request }) => {
  const result = await callTool(request, 'search_smpte', { q: 'traffic shaping sender', limit: 5 });
  const text: string = result.content[0].text;
  expect(text).toContain('slug: st2110-21');
  expect(result.structuredContent.results.length).toBeGreaterThan(0);
});

test('designator search finds the spec first', async ({ request }) => {
  const result = await callTool(request, 'search_smpte', { q: 'ST 2110-21', limit: 3 });
  expect(result.structuredContent.results[0].slug).toBe('st2110-21');
});

test('search collapses per-edition duplicates', async ({ request }) => {
  const { results } = (
    await callTool(request, 'search_smpte', { q: 'forward error correction', limit: 20 })
  ).structuredContent;
  const slugs = results.map((r: { slug: string }) => r.slug);
  expect(slugs.every((s: string) => !s.includes('_'))).toBe(true);
  expect(new Set(slugs).size).toBe(slugs.length);
});

test('read document by designator, with paging and find', async ({ request }) => {
  const page = await callTool(request, 'read_smpte_document', { slug: 'ST 2110-21', length: 800 });
  expect(page.content[0].text).toContain('next_offset: 800');

  const found = await callTool(request, 'read_smpte_document', {
    slug: 'st2110-21',
    find: 'leaky bucket',
  });
  expect(found.content[0].text).toContain('passage(s) containing "leaky bucket"');
});

test('unknown document is a tool error, not a crash', async ({ request }) => {
  const result = await callTool(request, 'read_smpte_document', { slug: 'does-not-exist' });
  expect(result.isError).toBe(true);
});

test('MCP App UI resource is served', async ({ request }) => {
  const res = await rpc(request, 'resources/read', { uri: 'ui://smpte-search/search.html' });
  expect(res.result.contents[0].text).toContain('<html');
});

test.describe('bearer token auth', () => {
  test.skip(!token, 'server is running without MCP_TOKEN');
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  test('rejects a request with no token', async ({ request }) => {
    const { authorization: _omit, ...noAuth } = headers as Record<string, string>;
    const res = await request.post('/mcp', { headers: noAuth, data: body });
    expect(res.status()).toBe(401);
  });

  test('rejects a request with the wrong token', async ({ request }) => {
    const res = await request.post('/mcp', {
      headers: { ...headers, authorization: 'Bearer not-the-token' },
      data: body,
    });
    expect(res.status()).toBe(401);
  });
});

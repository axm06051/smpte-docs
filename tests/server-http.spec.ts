import { expect, test } from '@playwright/test';

// Plain HTTP checks (no browser): compression, validators, allowlist, bad input.
const gz = { 'accept-encoding': 'gzip' };

test('fragments are gzipped only when accepted, and are identical once decoded', async ({
  request,
}) => {
  const url = '/search?q=color&full=1';
  const zipped = await request.get(url, { headers: gz });
  const plain = await request.get(url, { headers: { 'accept-encoding': 'identity' } });
  expect(zipped.headers()['content-encoding']).toBe('gzip');
  expect(plain.headers()['content-encoding']).toBeUndefined();
  expect(zipped.headers()['vary']).toContain('accept-encoding');
  expect(await zipped.text()).toBe(await plain.text());
});

test('index page honours Accept-Encoding instead of always sending gzip', async ({ request }) => {
  const plain = await request.get('/', { headers: { 'accept-encoding': 'identity' } });
  expect(plain.headers()['content-encoding']).toBeUndefined();
  expect(await plain.text()).toContain('SMPTE Document Library');
  const zipped = await request.get('/', { headers: gz });
  expect(zipped.headers()['content-encoding']).toBe('gzip');
});

test('static assets are cached, compressed and revalidate with a 304', async ({ request }) => {
  for (const path of ['/htmx.js', '/app.js', '/style.css']) {
    const res = await request.get(path, { headers: gz });
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-encoding'], path).toBe('gzip');
    expect(res.headers()['cache-control'], path).toContain('max-age');
    const etag = res.headers()['etag'];
    expect(etag, path).toBeTruthy();
    const again = await request.get(path, { headers: { ...gz, 'if-none-match': etag } });
    expect(again.status(), path).toBe(304);
  }
});

test('only the public files are served from src', async ({ request }) => {
  for (const path of ['/server.ts', '/catalog.ts', '/mcp.ts', '/app.ts', '/logger.ts'])
    expect((await request.get(path)).status(), path).toBe(404);
});

test('malformed percent-encoding is a 400, not a 500', async ({ request }) => {
  for (const path of ['/detail/%E0%A4%A', '/versions/%', '/detail/%zz'])
    expect((await request.get(path)).status(), path).toBe(400);
});

test('immutable fragments are cacheable; query-specific ones are not', async ({ request }) => {
  expect((await request.get('/versions/st2110-20')).headers()['cache-control']).toContain(
    'max-age',
  );
  expect((await request.get('/detail/st2110-20')).headers()['cache-control']).toContain('max-age');
  const withQuery = await request.get('/detail/st2110-20?q=color&full=1');
  expect(withQuery.headers()['cache-control']).toBeUndefined();
});

test('single-doc snippet keeps the highlighted match', async ({ request }) => {
  const tree = await (await request.get('/search?q=color&full=1')).text();
  const slugs = [...tree.matchAll(/data-slug="([^"]+)"/g)].map((m) => m[1]).slice(0, 40);
  let marked = 0;
  for (const slug of slugs) {
    const res = await request.get(`/detail/${slug}?q=color&full=1&re=0`);
    expect(res.status()).toBe(200);
    if ((await res.text()).includes('<mark>')) marked++;
  }
  expect(marked).toBeGreaterThan(0);
});

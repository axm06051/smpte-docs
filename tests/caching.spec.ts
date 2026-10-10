import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

// HTTP-level contract for delivery and caching (no browser).
const br = { 'accept-encoding': 'br' };
const gz = { 'accept-encoding': 'gzip' };
const none = { 'accept-encoding': 'identity' };

async function home(request: import('@playwright/test').APIRequestContext) {
  return (await request.get('/', { headers: none })).text();
}
const assetPaths = (html: string) =>
  [...html.matchAll(/\/assets\/(?:app|htmx)\.[0-9a-f]{10}\.js/g)].map((m) => m[0]);

test('HTML is revalidated on every load, never served stale from cache', async ({ request }) => {
  const res = await request.get('/', { headers: gz });
  expect(res.headers()['cache-control']).toBe('no-cache');
  const etag = res.headers()['etag'];
  expect(etag).toBeTruthy();
  const again = await request.get('/', { headers: { ...gz, 'if-none-match': etag } });
  expect(again.status()).toBe(304);
  expect(again.headers()['etag']).toBe(etag);
});

// Raw bytes as sent on the wire (fetch and APIRequestContext both decode transparently).
const BASE = new URL(process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`);
const wire = (path: string, encoding: string) =>
  new Promise<{ headers: import('node:http').IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      get(
        { host: BASE.hostname, port: BASE.port, path, headers: { 'accept-encoding': encoding } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        },
      ).on('error', reject);
    },
  );

test('brotli is used when accepted, gzip as the fallback, and all decode to the same bytes', async () => {
  const raw = (await wire('/', 'identity')).body;
  const b = await wire('/', 'br');
  const g = await wire('/', 'gzip');
  expect(b.headers['content-encoding']).toBe('br');
  expect(g.headers['content-encoding']).toBe('gzip');
  expect(b.headers['vary']).toContain('accept-encoding');
  expect(b.body.length).toBeLessThan(g.body.length);
  expect(b.body.length).toBeLessThan(raw.length / 4);
  expect(brotliDecompressSync(b.body).equals(raw)).toBe(true);
  expect(gunzipSync(g.body).equals(raw)).toBe(true);
});

test('app.js and htmx.js are content-hashed, immutable and compressed', async ({ request }) => {
  const paths = assetPaths(await home(request));
  expect(paths.map((p) => p.split('.')[0]).sort()).toEqual(['/assets/app', '/assets/htmx']);
  for (const path of paths) {
    const res = await request.get(path, { headers: br });
    expect(res.status(), path).toBe(200);
    expect(res.headers()['cache-control'], path).toBe('public, max-age=31536000, immutable');
    expect(res.headers()['content-encoding'], path).toBe('br');
    const body = await (await request.get(path, { headers: none })).body();
    // The URL is derived from the bytes: a changed file can never reuse an old URL.
    expect(path).toContain(`.${createHash('sha256').update(body).digest('hex').slice(0, 10)}.`);
    const etag = res.headers()['etag'];
    expect((await request.get(path, { headers: { ...br, 'if-none-match': etag } })).status()).toBe(
      304,
    );
  }
});

test('an unknown asset hash is a 404, not a stale file', async ({ request }) => {
  expect((await request.get('/assets/app.0000000000.js')).status()).toBe(404);
  expect((await request.get('/assets/nope.js')).status()).toBe(404);
});

test('critical CSS is inlined and the first screenful of rows is in the HTML', async ({
  request,
}) => {
  const html = await home(request);
  expect(html).not.toContain('<link rel="stylesheet"');
  expect(html).toMatch(/<style>[\s\S]*--selected:[\s\S]*<\/style>/);
  const before = html.slice(0, html.indexOf('id="search-data"'));
  const rows = before.match(/class="row[ "]/g)?.length ?? 0;
  expect(rows).toBeGreaterThanOrEqual(20);
  expect(rows).toBeLessThanOrEqual(80);
  expect(html).not.toContain('{{');
  expect(html).not.toContain('<!-- RESULTS -->');
});

test('theme is still applied before any styles can paint', async ({ request }) => {
  const html = await home(request);
  expect(html.indexOf("dataset.theme = localStorage.getItem('smpte-theme')")).toBeLessThan(
    html.indexOf('<style>'),
  );
});

test('legacy fixed-name assets still work', async ({ request }) => {
  for (const path of ['/app.js', '/htmx.js', '/style.css'])
    expect((await request.get(path, { headers: br })).headers()['content-encoding'], path).toBe(
      'br',
    );
});

test('fragments carry validators and revalidate with a 304', async ({ request }) => {
  for (const path of ['/versions/st2110-20', '/detail/st2110-20', '/search?q=2110&cat=ST']) {
    const res = await request.get(path, { headers: gz });
    const etag = res.headers()['etag'];
    expect(etag, path).toBeTruthy();
    expect(res.headers()['cache-control'], path).toContain('max-age');
    expect(
      (await request.get(path, { headers: { ...gz, 'if-none-match': etag } })).status(),
      path,
    ).toBe(304);
  }
});

test('detail is cacheable unless it carries a PDF-text snippet', async ({ request }) => {
  const cc = async (qs: string) =>
    (await request.get(`/detail/st2110-20${qs}`)).headers()['cache-control'];
  expect(await cc('')).toContain('max-age');
  expect(await cc('?q=color&re=0&full=0')).toContain('max-age'); // q is ignored without full=1
  expect(await cc('?q=color&re=0&full=1')).toBeUndefined();
});

test('fragment and document URLs never alias: no cache variation on HX-Request is needed', async ({
  request,
}) => {
  const plain = await request.get('/', { headers: none });
  const hx = await request.get('/', { headers: { ...none, 'hx-request': 'true' } });
  expect(await hx.text()).toBe(await plain.text());
  expect(hx.headers()['etag']).toBe(plain.headers()['etag']);
  const frag = await request.get('/detail/st2110-20', {
    headers: { ...none, 'hx-request': 'true' },
  });
  const fragPlain = await request.get('/detail/st2110-20', { headers: none });
  expect(await frag.text()).toBe(await fragPlain.text());
  expect(await fragPlain.text()).not.toContain('<html');
});

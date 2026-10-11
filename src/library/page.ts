// The HTML page and everything it loads: the inlined stylesheet, content-hashed app/htmx bundles,
// the legacy fixed-name assets and the favicons.
import { existsSync, readdirSync } from 'node:fs';
import { docs, roots, searchData } from '../catalog';
import {
  type Blob,
  type Bytes,
  digest,
  IMMUTABLE,
  makeBlob,
  notFound,
  PROD,
  serveBlob,
  SHORT,
} from '../platform/http';
import { logger, since } from '../platform/logger';
import { treeRow } from './render';

// First paint must not wait for JavaScript, but rendering every root row would add ~30 KB (gzip) to
// every load.  So the first screenful is rendered here with the very function app.js uses
// (tests/prefetch.spec.ts asserts the markup is identical), and app.js renders the full tree after
// parsing, replacing identical markup, so nothing shifts.
const SSR_ROWS = 30;
const initialTree = roots
  .slice(0, SSR_ROWS)
  .map((d) => treeRow(d, 0))
  .join('');

// ---- The page and its content-hashed assets -----------------------------------------------------
// The HTML inlines the stylesheet (no render-blocking request) and references app.js / htmx.js by
// content hash, so those can be cached forever.  The HTML itself is revalidated on every load (a
// 304 is one round trip), so a deploy can never leave a cached page pointing at assets that no
// longer exist.  In development the page is rebuilt when any input file changes.
const HTMX_FILE = 'node_modules/htmx.org/dist/htmx.min.js';
const CLIENT_DIR = './src/library/client';
const PAGE_FILES = [
  `${CLIENT_DIR}/index.html`,
  `${CLIENT_DIR}/style.css`,
  `${CLIENT_DIR}/app.js`,
  HTMX_FILE,
];
type Page = { html: Blob; assets: Map<string, Blob> };
async function buildPage(): Promise<Page> {
  const [tpl, css, app, htmx] = await Promise.all([
    Bun.file(PAGE_FILES[0]).text(),
    Bun.file(PAGE_FILES[1]).text(),
    Bun.file(PAGE_FILES[2])
      .bytes()
      .catch(() => {
        throw new Error('src/library/client/app.js is missing: run `bun run build:app` first');
      }),
    Bun.file(PAGE_FILES[3]).bytes(),
  ]);
  const js = 'text/javascript;charset=utf-8';
  const assets = new Map<string, Blob>();
  const appPath = `/assets/app.${digest(app)}.js`;
  const htmxPath = `/assets/htmx.${digest(htmx)}.js`;
  assets.set(appPath, makeBlob(app as Bytes, js));
  assets.set(htmxPath, makeBlob(htmx as Bytes, js));
  // Function replacers: titles or CSS containing `$&`, `$'` etc. must not be interpreted.
  const html = tpl
    .replace('<!-- RESULTS -->', () => initialTree)
    .replace('{{META}}', () => `${docs.length} documents`)
    .replace('{{SEARCH_INDEX}}', () => searchData)
    .replace('<link rel="stylesheet" href="/style.css" />', () => `<style>${css}</style>`)
    .replace(
      '<script src="/htmx.js" defer></script>',
      () => `<script src="${htmxPath}" defer fetchpriority="low"></script>`,
    )
    .replace(
      '<script src="/app.js" defer></script>',
      () => `<script src="${appPath}" defer></script>`,
    );
  return {
    html: makeBlob(new TextEncoder().encode(html) as Bytes, 'text/html; charset=utf-8'),
    assets,
  };
}
let page = await buildPage();
logger.info('page assets prepared', {
  htmlBytes: page.html.raw.length,
  assetCount: page.assets.size,
  production: PROD,
});

const stamp = () => PAGE_FILES.map((f) => Bun.file(f).lastModified).join();
let seen = stamp();
let checkedAt = 0;
async function currentPage() {
  if (PROD) return page;
  const now = performance.now();
  if (now - checkedAt > 500) {
    checkedAt = now;
    const s = stamp();
    if (s !== seen) {
      logger.info('page inputs changed; rebuilding page');
      seen = s;

      const started = performance.now();

      try {
        page = await buildPage();

        logger.info('page rebuild completed', {
          assets: page.assets.size,
          htmlBytes: page.html.raw.length,
          ms: since(started),
        });
      } catch (error) {
        logger.error('page rebuild failed', {
          ms: since(started),
          error,
        });
        throw error;
      }
    }
  }
  return page;
}

// Legacy fixed-name assets (/app.js, /style.css, /htmx.js): kept for compatibility with anything that
// still links them.  Read + compressed once, revalidated by mtime so `bun --watch` rebuilds are seen.
const assets = new Map<string, Blob & { mtime: number }>();
async function staticAsset(req: Request, name: string, path: string, cc: string, preGz?: string) {
  const f = Bun.file(path);
  let a = assets.get(name);
  const mtime = f.lastModified;
  if (!a || a.mtime !== mtime) {
    if (!(await f.exists())) return notFound();
    const raw = new Uint8Array(await f.arrayBuffer());
    const pre = preGz ? Bun.file(preGz) : null;
    const gz = pre && (await pre.exists()) ? new Uint8Array(await pre.arrayBuffer()) : undefined;
    a = { ...makeBlob(raw, f.type, gz), mtime };
    assets.set(name, a);
  }
  return serveBlob(req, a, cc);
}

const FAVICON_DIR = './public/favicon/';
const FAVICONS = new Set(existsSync(FAVICON_DIR) ? readdirSync(FAVICON_DIR) : []);

// Everything that is not a data fragment; null means "not a page route".
export async function pageRoute(req: Request, u: URL): Promise<Response | null> {
  // public/favicon/* is served from the site root (the web manifest links /web-app-manifest-*.png).
  if (FAVICONS.has(u.pathname.slice(1)))
    return staticAsset(req, u.pathname, FAVICON_DIR + u.pathname.slice(1), 'public, max-age=86400');
  if (u.pathname === '/htmx.js')
    return staticAsset(req, u.pathname, HTMX_FILE, 'public, max-age=3600', `${HTMX_FILE}.gz`);
  if (u.pathname === '/' || u.pathname === '/index.html')
    return serveBlob(req, (await currentPage()).html, 'no-cache');
  if (u.pathname.startsWith('/assets/')) {
    const a = (await currentPage()).assets.get(u.pathname);
    return a ? serveBlob(req, a, IMMUTABLE) : notFound();
  }
  // Only these files are public; everything else under ./src (server.ts, catalog/, ...) is not.
  if (u.pathname === '/app.js' || u.pathname === '/style.css')
    return staticAsset(req, u.pathname, CLIENT_DIR + u.pathname, SHORT);
  return null;
}

import { existsSync, readdirSync } from 'node:fs';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { db, DB_PATH, rowIds } from './db';
import { mcp } from './mcp';
import RAW from './catalog';
import { logger, since } from './logger';
import {
  BASE,
  cnt,
  docUrl,
  escRe,
  esc,
  highlight,
  mark,
  previewHtml,
  rowHtml,
  tokens,
  treeRow,
  type SearchDoc,
} from './shared';
import { firstBodyMatch, NOISE_CONFIG } from './toc';

type Version = string | { k?: string; s?: string };
type PdfUrls = Record<string, string>;
type Versions = Record<string, Version[]>;

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const value = (await Bun.file(path).json()) as T;
    logger.debug('metadata file loaded', { path });
    return value;
  } catch (error) {
    logger.warning('metadata file unavailable; using fallback', {
      path,
      error,
    });
    return fallback;
  }
}

const versions = await loadJson<Versions>('.data/versions.json', {});
const pdfUrls = await loadJson<PdfUrls>('.data/pdf-urls.json', {});

const pdfBySlug = new Map<string, string>();
for (const [path, url] of Object.entries(pdfUrls)) {
  const match =
    path.match(/^\/doc\/([^/]+)\/.*\.pdf$/i) || path.match(/^\/latest\/([^/]+)\/.*\.pdf$/i);
  if (match && !pdfBySlug.has(match[1])) pdfBySlug.set(match[1], url);
}
const HOST = process.env.HOST ?? 'localhost';
const PORT = Number(process.env.PORT ?? 3000);

// One doc shape for the whole app: it is exactly what the page receives as JSON, and what the
// shared render functions take, so server and client markup cannot drift apart.
const docs: SearchDoc[] = RAW.map(([slug, title], id) => {
  const designator = title.split(',')[0].trim();
  const m = /^(OV|RP|EG|RDD|ST)?\s*([0-9]+(?:\.[0-9]+)?(?:-[0-9]+)?)/.exec(title);
  return {
    id,
    slug,
    title,
    name: title.slice(designator.length).replace(/^\s*,\s*/, '') || title,
    designator,
    cat: m?.[1] || '',
    parent: -1,
    children: [],
    versions: versions[slug]?.length || 0,
  };
});

const bySlug = new Map(docs.map((d) => [d.slug, d]));
const allDocIds = new Set(docs.map((d) => d.id));
const autocompleteText = docs.map((d) => `${d.designator} ${d.title} ${d.slug}`.toLowerCase());
const searchIndex = new Map<string, number[]>();
for (const d of docs) {
  for (const word of new Set(tokens(autocompleteText[d.id]))) {
    const ids = searchIndex.get(word);
    if (ids) ids.push(d.id);
    else searchIndex.set(word, [d.id]);
  }
}
function indexedIds(q: string) {
  const words = tokens(q);
  if (!words.length) return [];
  // A whole-word hit list is already known to contain the word; otherwise scan for a substring.
  let ids =
    searchIndex.get(words[0]) ??
    docs.filter((d) => autocompleteText[d.id].includes(words[0])).map((d) => d.id);
  for (let i = 1; i < words.length && ids.length; i++)
    ids = ids.filter((id) => autocompleteText[id].includes(words[i]));
  return ids;
}
RAW.forEach(([, , parentSlug], id) => {
  const parent = parentSlug ? bySlug.get(parentSlug) : undefined;
  if (parent && parent.id !== id) {
    docs[id].parent = parent.id;
    parent.children.push(id);
  }
});

const nums = docs.map((d) => (d.designator.match(/\d+/g) || []).map(Number));
const cmp = (a: SearchDoc, b: SearchDoc) => {
  const x = nums[a.id],
    y = nums[b.id];
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] ?? -1) - (y[i] ?? -1);
  return a.slug.localeCompare(b.slug);
};
const roots = docs.filter((d) => d.parent < 0).sort(cmp);
for (const d of docs) d.children.sort((a, b) => cmp(docs[a], docs[b]));

const searchData = JSON.stringify(docs).replaceAll('<', '\\u003c');

const pdfUrl = (d: SearchDoc) => pdfBySlug.get(d.slug) || `${BASE}/doc/${d.slug}/`;

function versionRows(d: SearchDoc) {
  return (versions[d.slug] || [])
    .map((v) => {
      const key = typeof v === 'string' ? v : v.k || '';
      const status = typeof v === 'string' ? '' : v.s || '';
      const m = /^(\d{8})-(.+)$/.exec(key);
      if (!m) return '';
      const date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`;
      const href = pdfUrls[`/doc/${d.slug}/${key}/`] || `${BASE}/doc/${d.slug}/${key}/`;
      return `<li><span class="slug">${date}</span><span class="cat kind">${esc(m[2].toUpperCase())}</span>${status ? `<span class="cat ${status === 'active' ? 'st-active' : 'st-old'}">${esc(status.toUpperCase())}</span>` : ''}<a href="${esc(href)}" target="_blank" rel="noopener">${esc(d.designator)} · ${esc(date)}</a></li>`;
    })
    .join('');
}

const counts: number[] = [];
const count = (d: SearchDoc): number =>
  (counts[d.id] ??= d.children.reduce((n, id) => n + 1 + count(docs[id]), 0));

function detailPreview(d: SearchDoc, q = '', re = false, full = false) {
  let body = previewHtml(d, docs);
  if (full && q) {
    const snippet = docSnippet(d, q, re);
    if (snippet) body += `<div class="pv-meta">…${highlightSnippet(snippet, q, re)}…</div>`;
  }
  return body;
}

const fullSlugs = new Map<string, string[]>();
const allFullSlugs = docs.map((d) => d.slug);
for (const d of docs) {
  const slugs = fullSlugs.get(d.cat);
  if (slugs) slugs.push(d.slug);
  else fullSlugs.set(d.cat, [d.slug]);
}
const inList = (slugs: string[]) => `slug IN (${slugs.map(() => '?').join(',')})`;
const fullQueries = new Map([...fullSlugs].map(([cat, slugs]) => [cat, inList(slugs)]));
const fullQueryAll = inList(allFullSlugs);
// FTS5 prefix query: every word must match.
const ftsAnd = (q: string) =>
  tokens(q)
    .map((w) => `"${w.replaceAll('"', '""')}"*`)
    .join(' AND ');
type TextRow = { slug: string; text: string };

function fullRows(q: string, cat: string, re: boolean) {
  const slugs = cat ? fullSlugs.get(cat) || [] : allFullSlugs;
  const where = cat ? fullQueries.get(cat) || '0' : fullQueryAll;
  if (re) return db.query(`SELECT slug, text FROM docs WHERE ${where}`).all(...slugs) as TextRow[];
  const match = ftsAnd(q);
  if (!match) return [];
  return db
    .query(`SELECT slug, text FROM docs WHERE docs MATCH ? AND ${where}`)
    .all(match, ...slugs) as TextRow[];
}

const snippetRegex = (q: string, re: boolean) => {
  try {
    const words = re ? [q] : tokens(q);
    if (!words.length) return null;
    return new RegExp(words.map(escRe).join('|'), 'i');
  } catch (error) {
    logger.warning('PDF-text snippet pattern is invalid', { query: q, regex: re, error });
    return null;
  }
};

// First match outside a TOC / embedded binary. Each rejected match is traced so a missing or
// surprising snippet can be explained from the log.
const bodyMatch = (slug: string, text: string, rx: RegExp) =>
  firstBodyMatch(text, rx, (reason, at) =>
    logger.trace('PDF-text match skipped as noise', { slug, reason, at }),
  );
const around = (text: string, index: number) => text.slice(Math.max(0, index - 80), index + 200);
const snippetAt = (slug: string, text: string, rx: RegExp) => {
  const index = bodyMatch(slug, text, rx);
  if (index < 0) logger.debug('no body match for snippet', { slug, textLength: text.length });
  return index >= 0 ? around(text, index) : undefined;
};
// Constant-time snippet for ONE doc (used by /detail); same text/offsets as fullSnippets().
function docSnippet(d: SearchDoc, q: string, re: boolean) {
  const rowid = rowIds.get(d.slug);
  const rx = snippetRegex(q, re);
  if (rowid === undefined || !rx) return undefined;
  try {
    const row = re
      ? db.query('SELECT text FROM docs WHERE rowid = ?').get(rowid)
      : db.query('SELECT text FROM docs WHERE docs MATCH ? AND rowid = ?').get(ftsAnd(q), rowid);
    return row ? snippetAt(d.slug, (row as { text: string }).text, rx) : undefined;
  } catch (error) {
    // A broken snippet must not turn the whole preview into a 500.
    logger.error('PDF-text snippet lookup failed', { slug: d.slug, query: q, regex: re, error });
    return undefined;
  }
}

function fullSnippets(q: string, cat: string, re: boolean) {
  const started = performance.now();
  const snippets = new Map<string, string>();
  const rx = snippetRegex(q, re);
  if (!rx) return snippets;
  const rows = fullRows(q, cat, re);
  for (const r of rows) {
    const index = bodyMatch(r.slug, r.text, rx);
    if (index >= 0) snippets.set(r.slug, around(r.text, index));
  }
  const noiseOnly = rows.length - snippets.size;
  logger.debug('PDF-text snippets extracted', {
    query: q,
    category: cat || undefined,
    regex: re,
    scanned: rows.length,
    withBodyMatch: snippets.size,
    noiseOnly,
    ms: since(started),
  });
  if (rows.length > 0 && snippets.size === 0)
    logger.warning('every PDF-text match was a table of contents or embedded data', {
      query: q,
      scanned: rows.length,
    });
  return snippets;
}
function highlightSnippet(s: string, q: string, re: boolean) {
  if (re) {
    try {
      return mark(s, new RegExp(q, 'gi'));
    } catch {}
  }
  return highlight(s, tokens(q), true);
}

function search(q: string, cat: string, re: boolean, full: boolean, fullMatchSlugs?: Set<string>) {
  if (!q && !cat) return allDocIds;
  let match = docs;
  if (q) {
    if (full) {
      const hits = fullMatchSlugs || new Set(fullSnippets(q, cat, re).keys());
      match = match.filter((d) => hits.has(d.slug));
    } else if (re) {
      try {
        const rx = new RegExp(q, 'i');
        match = match.filter((d) => rx.test(d.title) || rx.test(d.slug));
      } catch {
        match = [];
      }
    } else {
      const ids = new Set(indexedIds(q));
      match = docs.filter((d) => ids.has(d.id));
    }
  }
  if (cat) match = match.filter((d) => d.cat === cat);
  const ids = new Set<number>();
  for (const d of match)
    for (let n: SearchDoc | undefined = d; n; n = docs[n.parent]) ids.add(n.id);
  return ids;
}

// A row of a /search result: unlike the lazily hydrated rows (shared.ts treeRow) the whole subtree is
// rendered, suites are open, leaves link straight to their PDF, and a PDF-text hit adds its snippet.
function rowFiltered(
  d: SearchDoc,
  level: number,
  ids: Set<number>,
  snippets: Map<string, string>,
  q: string,
  re: boolean,
): string {
  const suite = d.children.length > 0;
  const snippet = suite ? undefined : snippets.get(d.slug);
  return rowHtml(d, level, {
    open: suite,
    href: suite ? docUrl(d.slug) : pdfUrl(d),
    name: esc(d.name),
    tail: suite
      ? `<span class="cnt">${count(d)} parts</span>`
      : d.versions
        ? cnt(d.versions, 'version')
        : '',
    kids: suite
      ? `<ul class="list" role="group">${d.children
          .filter((id) => ids.has(id))
          .map((id) => rowFiltered(docs[id], level + 1, ids, snippets, q, re))
          .join('')}</ul>`
      : '<ul class="versions"></ul>',
    extra: snippet && `<div class="sn">…${highlightSnippet(snippet, q, re)}…</div>`,
  });
}
function tree(q = '', cat = '', re = false, full = false) {
  const snippets = full && q ? fullSnippets(q, cat, re) : new Map<string, string>();
  const ids = search(q, cat, re, full, full && q ? new Set(snippets.keys()) : undefined);
  return roots.map((d) => (ids.has(d.id) ? rowFiltered(d, 0, ids, snippets, q, re) : '')).join('');
}

// First paint must not wait for JavaScript, but rendering every root row would add ~30 KB (gzip) to
// every load.  So the first screenful is rendered here with the very function app.js uses
// (tests/prefetch.spec.ts asserts the markup is identical), and app.js renders the full tree after
// parsing, replacing identical markup, so nothing shifts.
const SSR_ROWS = 30;
const initialTree = roots
  .slice(0, SSR_ROWS)
  .map((d) => treeRow(d, 0))
  .join('');

// ---- Compression + validators ------------------------------------------------------------------
// Everything that is compressed more than once is compressed once, at startup or first use.
type Enc = 'br' | 'gzip' | '';
type Bytes = Uint8Array<ArrayBuffer>;
const PROD = process.env.NODE_ENV === 'production';
const negotiate = (req: Request): Enc => {
  const h = req.headers.get('accept-encoding') ?? '';
  return /\bbr\b/.test(h) ? 'br' : /\bgzip\b/.test(h) ? 'gzip' : '';
};
const brotli = (b: string | Uint8Array, quality: number): Bytes =>
  new Uint8Array(brotliCompressSync(b, { params: { [zlib.BROTLI_PARAM_QUALITY]: quality } }));
const digest = (b: string | Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(b).digest('hex').slice(0, 10);

// A fully prepared response body: raw + both encodings + a weak validator (weak because the bytes
// differ per Content-Encoding even though the representation is the same).
type Blob = { raw: Bytes; gz: Bytes; br: Bytes; etag: string; type: string };
function makeBlob(raw: Bytes, type: string, gz?: Bytes): Blob {
  return {
    raw,
    gz: gz ?? Bun.gzipSync(raw, { level: 9 }),
    br: brotli(raw, PROD ? 11 : 5),
    etag: `W/"${digest(raw)}"`,
    type,
  };
}
function serveBlob(req: Request, a: Blob, cc: string) {
  const headers: Record<string, string> = {
    'content-type': a.type,
    'cache-control': cc,
    etag: a.etag,
    vary: 'accept-encoding',
  };
  if (req.headers.get('if-none-match') === a.etag)
    return new Response(null, { status: 304, headers });
  const enc = negotiate(req);
  if (!enc) return new Response(a.raw, { headers });
  headers['content-encoding'] = enc;
  return new Response(enc === 'br' ? a.br : a.gz, { headers });
}

// ---- The page and its content-hashed assets -----------------------------------------------------
// The HTML inlines the stylesheet (no render-blocking request) and references app.js / htmx.js by
// content hash, so those can be cached forever.  The HTML itself is revalidated on every load (a
// 304 is one round trip), so a deploy can never leave a cached page pointing at assets that no
// longer exist.  In development the page is rebuilt when any input file changes.
const HTMX_FILE = 'node_modules/htmx.org/dist/htmx.min.js';
const PAGE_FILES = ['./src/index.html', './src/style.css', './src/app.js', HTMX_FILE];
type Page = { html: Blob; assets: Map<string, Blob> };
async function buildPage(): Promise<Page> {
  const [tpl, css, app, htmx] = await Promise.all([
    Bun.file(PAGE_FILES[0]).text(),
    Bun.file(PAGE_FILES[1]).text(),
    Bun.file(PAGE_FILES[2])
      .bytes()
      .catch(() => {
        throw new Error('src/app.js is missing: run `bun run build:app` first');
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

logger.info('snippet noise filter configured', NOISE_CONFIG);
logger.info('server initialized', {
  docs: docs.length,
  roots: roots.length,
  indexedTerms: searchIndex.size,
  database: DB_PATH,
  versions: Object.keys(versions).length,
  pdfUrls: Object.keys(pdfUrls).length,
  port: PORT,
  environment: process.env.NODE_ENV ?? 'development',
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
const SHORT = 'public, max-age=300';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
const bad = () => new Response('bad request', { status: 400 });
const notFound = () => new Response('not found', { status: 404 });

// Fragments: compressed only when the client accepts it and the body is big enough to pay for it.
// Validators let an expired entry revalidate with a 304 instead of re-sending the body.
type Packed = { raw: string; gz?: Bytes; br?: Bytes; etag?: string; live?: boolean };
function htmlResponse(req: Request, p: Packed, cc = '') {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    vary: 'accept-encoding',
  };
  if (cc) {
    p.etag ??= `W/"${Bun.hash(p.raw).toString(36)}"`;
    headers['cache-control'] = cc;
    headers.etag = p.etag;
    if (req.headers.get('if-none-match') === p.etag)
      return new Response(null, { status: 304, headers });
  }
  const enc = p.raw.length < 1024 ? '' : negotiate(req);
  if (!enc) return new Response(p.raw, { headers });
  if (enc === 'br' ? !p.br : !p.gz) {
    const z = enc === 'br' ? (p.br = brotli(p.raw, 4)) : (p.gz = Bun.gzipSync(p.raw, { level: 4 }));
    if (p.live) cacheBytes += z.length;
  }
  headers['content-encoding'] = enc;
  return new Response(enc === 'br' ? p.br : p.gz, { headers });
}
const html = (req: Request, body: string, cc = '') => htmlResponse(req, { raw: body }, cc);

// Bounded LRU for the expensive /search fragments: a repeat query costs a Map hit, not an FTS scan,
// and each encoding is computed once per entry.
const MAX_ENTRIES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const packedCache = new Map<string, Packed>();
let cacheBytes = 0;
function packed(key: string, make: () => string): Packed {
  const started = performance.now();
  const hit = packedCache.get(key);
  if (hit) {
    packedCache.delete(key);
    packedCache.set(key, hit);
    logger.debug('search fragment cache hit', {
      entries: packedCache.size,
      cacheBytes,
    });
    return hit;
  }
  logger.debug('search fragment cache miss', {
    entries: packedCache.size,
    cacheBytes,
  });
  const p: Packed = { raw: make(), live: true };
  packedCache.set(key, p);
  cacheBytes += p.raw.length;
  let evicted = 0;
  for (const [k, v] of packedCache) {
    if (packedCache.size <= MAX_ENTRIES && cacheBytes <= MAX_BYTES) break;
    packedCache.delete(k);
    v.live = false;
    cacheBytes -= v.raw.length + (v.gz?.length ?? 0) + (v.br?.length ?? 0);
    evicted++;
  }
  logger.trace('search fragment rendered', {
    htmlBytes: p.raw.length,
    entries: packedCache.size,
    cacheBytes,
    evicted,
    ms: since(started),
  });

  return p;
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

Bun.serve({
  port: PORT,

  async fetch(req) {
    const started = performance.now();
    const u = new URL(req.url);
    const path = u.pathname;

    logger.trace('HTTP request started', {
      method: req.method,
      path,
      queryPresent: u.search.length > 0,
    });

    try {
      const response = await handleRequest(req, u);
      const ms = since(started);

      const context = {
        method: req.method,
        path,
        status: response.status,
        ms,
      };

      if (response.status >= 500) {
        logger.error('HTTP request completed with server error', context);
      } else if (response.status >= 400) {
        logger.warning('HTTP request completed with client error', context);
      } else {
        logger.info('HTTP request completed', context);
      }

      return response;
    } catch (error) {
      logger.error('HTTP request failed with exception', {
        method: req.method,
        path,
        ms: since(started),
        error,
      });

      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
});

logger.info('HTTP server listening', {
  host: HOST,
  port: PORT,
  url: `http://${HOST}:${PORT}`,
  production: PROD,
});

async function handleRequest(req: Request, u: URL): Promise<Response> {
  if (u.pathname === '/healthz') return new Response('ok');
  if (u.pathname === '/mcp') return mcp.fetch(req);
  if (u.pathname.startsWith('/detail/')) {
    const slug = decode(u.pathname.slice('/detail/'.length));
    if (slug === null) {
      logger.warning('invalid detail URL encoding', {
        path: u.pathname,
      });
      return bad();
    }
    const d = bySlug.get(slug);
    if (!d) {
      logger.debug('detail document not found', { slug });
      return notFound();
    }
    const q = u.searchParams.get('q') || '';
    const body = detailPreview(
      d,
      q,
      u.searchParams.get('re') === '1',
      u.searchParams.get('full') === '1',
    );
    // The fragment only depends on q/re when a PDF-text snippet is requested; otherwise it is
    // immutable until restart, so let the browser (and the prefetcher) reuse it.
    return html(req, body, q && u.searchParams.get('full') === '1' ? '' : SHORT);
  }

  if (u.pathname === '/search') {
    const q = u.searchParams.get('q') || '';
    const cat = u.searchParams.get('cat') || '';
    const re = u.searchParams.get('re') === '1';
    const full = u.searchParams.get('full') === '1';

    logger.debug('search request', {
      query: q,
      category: cat || undefined,
      regex: re,
      fullText: full,
    });

    const started = performance.now();

    const result = packed(`${q}\0${cat}\0${re}\0${full}`, () => tree(q, cat, re, full));

    logger.trace('search response prepared', {
      htmlBytes: result.raw.length,
      cachedEncoding: {
        gzip: Boolean(result.gz),
        brotli: Boolean(result.br),
      },
      ms: since(started),
    });

    return htmlResponse(req, result, SHORT);
  }

  if (u.pathname.startsWith('/versions/')) {
    const slug = decode(u.pathname.slice(10));
    if (slug === null) return bad();
    const d = bySlug.get(slug);
    return d ? html(req, versionRows(d), SHORT) : notFound();
  }
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
  // Only these files are public; everything else under ./src (server.ts, catalog.ts, ...) is not.
  if (u.pathname === '/app.js' || u.pathname === '/style.css')
    return staticAsset(req, u.pathname, './src' + u.pathname, SHORT);
  return notFound();
}

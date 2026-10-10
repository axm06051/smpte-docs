import { Database } from 'bun:sqlite';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { mcp } from './mcp';
import RAW from './catalog';
import { logger } from './logger';
import { firstBodyMatch, NOISE_CONFIG } from './toc';

type Version = string | { k?: string; s?: string };
type Doc = {
  id: number;
  slug: string;
  title: string;
  name: string;
  parentSlug: string | null;
  cat: string;
  designator: string;
  nums: number[];
  children: Doc[];
  parent: Doc | null;
};

type PdfUrls = Record<string, string>;
type Versions = Record<string, Version[]>;

const DB_PATH = '.data/searchindex.sqlite';
const db = (() => {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch (error) {
    logger.fatal('search index cannot be opened; build it with `bun run index`', {
      path: DB_PATH,
      error,
    });
    throw error;
  }
})();

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
const BASE = 'https://pub.smpte.org';
const HOST = process.env.HOST ?? 'localhost';
const PORT = Number(process.env.PORT ?? 3000);

const docs: Doc[] = RAW.map(([slug, title, parentSlug], id) => {
  const designator = title.split(',')[0].trim();
  const m = /^(OV|RP|EG|RDD|ST)?\s*([0-9]+(?:\.[0-9]+)?(?:-[0-9]+)?)/.exec(title);
  return {
    id,
    slug,
    title,
    name: title.slice(designator.length).replace(/^\s*,\s*/, '') || title,
    parentSlug: parentSlug ?? null,
    cat: m?.[1] || '',
    designator,
    nums: (designator.match(/\d+/g) || []).map(Number),
    children: [],
    parent: null,
  };
});

const bySlug = new Map(docs.map((d) => [d.slug, d]));
const allDocIds = new Set(docs.map((d) => d.id));
const autocompleteText = new Map(
  docs.map((d) => [d.id, `${d.designator} ${d.title} ${d.slug}`.toLowerCase()]),
);
const searchIndex = new Map<string, number[]>();
for (const d of docs) {
  for (const word of new Set(tokens(autocompleteText.get(d.id)!))) {
    const ids = searchIndex.get(word);
    if (ids) ids.push(d.id);
    else searchIndex.set(word, [d.id]);
  }
}
function indexedIds(q: string) {
  const words = tokens(q);
  if (!words.length) return [] as number[];
  let ids = searchIndex.get(words[0]) || [];
  if (!ids.length) {
    const needle = words[0];
    ids = docs.filter((d) => autocompleteText.get(d.id)!.includes(needle)).map((d) => d.id);
  } else {
    ids = ids.filter((id) => autocompleteText.get(id)!.includes(words[0]));
  }
  for (let i = 1; i < words.length && ids.length; i++) {
    const needle = words[i];
    ids = ids.filter((id) => autocompleteText.get(id)!.includes(needle));
  }
  return ids;
}
for (const d of docs) {
  const parent = d.parentSlug ? bySlug.get(d.parentSlug) : undefined;
  if (parent && parent !== d) {
    d.parent = parent;
    parent.children.push(d);
  }
}

const cmp = (a: Doc, b: Doc) => {
  const n = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < n; i++)
    if (a.nums[i] !== b.nums[i]) return (a.nums[i] ?? -1) - (b.nums[i] ?? -1);
  return a.slug.localeCompare(b.slug);
};
const roots = docs.filter((d) => !d.parent).sort(cmp);
for (const d of docs) d.children.sort(cmp);

const searchData = JSON.stringify(
  docs.map((d) => ({
    id: d.id,
    slug: d.slug,
    title: d.title,
    name: d.name,
    designator: d.designator,
    cat: d.cat,
    parent: d.parent?.id ?? -1,
    children: d.children.map((c) => c.id),
    versions: versions[d.slug]?.length || 0,
  })),
).replaceAll('<', '\\u003c');

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const pdfUrl = (d: Doc) => pdfBySlug.get(d.slug) || `${BASE}/doc/${d.slug}/`;

function versionRows(d: Doc) {
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

const counts = new Map<number, number>();
function count(d: Doc): number {
  const cached = counts.get(d.id);
  if (cached !== undefined) return cached;
  const value = d.children.reduce((n, c) => n + 1 + count(c), 0);
  counts.set(d.id, value);
  return value;
}
function row(d: Doc, level = 0): string {
  const pad = 12 + level * 22;
  const attrs = `role="treeitem" aria-level="${level + 1}" tabindex="-1" data-slug="${esc(d.slug)}" data-preview="/detail/${esc(d.slug)}" style="padding-left:${pad}px"`;
  if (d.children.length)
    return `<li class="row suite" ${attrs}><details><summary><span class="tg-sp"></span><span class="slug">${esc(d.designator)}</span><span class="title"><span class="cat suite">${esc(d.cat || 'SUITE')}</span><a href="${BASE}/doc/${esc(d.slug)}/" target="_blank" rel="noopener">${esc(d.name)}</a><span class="cnt">${count(d)} part${count(d) === 1 ? '' : 's'}</span></span></summary><ul class="list" role="group">${d.children.map((c) => row(c, level + 1)).join('')}</ul></details></li>`;
  const n = versions[d.slug]?.length;
  return `<li class="row" ${attrs}><details><summary><span class="tg-sp"></span><span class="slug">${esc(d.designator)}</span><span class="title"><span class="cat">${esc(d.cat)}</span><a href="${esc(pdfUrl(d))}" target="_blank" rel="noopener">${esc(d.name)}</a>${n ? `<span class="cnt">${n} version${n === 1 ? '' : 's'}</span>` : ''}</span></summary><ul class="versions"></ul></details></li>`;
}

function detailPreview(d: Doc, q = '', re = false, full = false) {
  let body = autocompletePreview(d);
  if (full && q) {
    const snippet = docSnippet(d, q, re);
    if (snippet) body += `<div class="pv-meta">…${highlightSnippet(snippet, q, re)}…</div>`;
  }
  return body;
}

function autocompletePreview(d: Doc) {
  const crumbs: string[] = [];
  for (let p: Doc | null = d.parent; p; p = p.parent) crumbs.unshift(p.designator);
  let body = `<div class="pv-top"><span class="cat">${esc(d.cat)}</span><span class="pv-des">${esc(d.designator)}</span></div>`;
  body += `<div class="pv-title">${esc(d.name)}</div>`;
  if (crumbs.length) body += `<div class="pv-meta">Suite: <b>${esc(crumbs.join(' › '))}</b></div>`;
  if (d.parent) {
    const part = d.parent.children.indexOf(d) + 1;
    body += `<div class="pv-meta">Part ${part} of ${d.parent.children.length} in ${esc(d.parent.designator)}</div>`;
  }
  if (d.children.length) {
    const first = d.children
      .slice(0, 5)
      .map((c) => esc(c.designator))
      .join(', ');
    body += `<div class="pv-meta"><b>${d.children.length}</b> part${d.children.length === 1 ? '' : 's'}: ${first}${d.children.length > 5 ? ` &hellip; +${d.children.length - 5} more` : ''}</div>`;
  }
  const dated = versions[d.slug]?.length || 0;
  if (dated)
    body += `<div class="pv-meta"><b>${dated}</b> dated version${dated === 1 ? '' : 's'}</div>`;
  body += `<div class="pv-meta"><a href="${esc(`${BASE}/doc/${d.slug}/`)}" target="_blank" rel="noopener">Open document page &#8599;</a></div>`;
  return body;
}

function tokens(q: string) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
function highlight(s: string, pieces: string[]) {
  if (!pieces.length) return esc(s);
  const re = new RegExp(
    `\\b(${pieces.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  let out = '';
  let last = 0;
  for (const m of s.matchAll(re)) {
    const index = m.index ?? 0;
    out += esc(s.slice(last, index)) + `<mark>${esc(m[0])}</mark>`;
    last = index + m[0].length;
  }
  return out + esc(s.slice(last));
}
const fullSlugs = new Map<string, string[]>();
const allFullSlugs = docs.map((d) => d.slug);
for (const d of docs) {
  const slugs = fullSlugs.get(d.cat);
  if (slugs) slugs.push(d.slug);
  else fullSlugs.set(d.cat, [d.slug]);
}
const fullQueries = new Map<string, string>();
for (const [cat, slugs] of fullSlugs)
  fullQueries.set(cat, `slug IN (${slugs.map(() => '?').join(',')})`);
const fullQueryAll = `slug IN (${allFullSlugs.map(() => '?').join(',')})`;

function fullRows(q: string, cat: string, re: boolean) {
  const slugs = cat ? fullSlugs.get(cat) || [] : allFullSlugs;
  const where = cat ? fullQueries.get(cat) || '0' : fullQueryAll;
  if (re)
    return db.query(`SELECT slug, text FROM docs WHERE ${where}`).all(...slugs) as {
      slug: string;
      text: string;
    }[];
  const words = tokens(q);
  if (!words.length) return [];
  const match = words.map((w) => `"${w.replaceAll('"', '""')}"*`).join(' AND ');
  return db
    .query(`SELECT slug, text FROM docs WHERE docs MATCH ? AND ${where}`)
    .all(match, ...slugs) as {
    slug: string;
    text: string;
  }[];
}

// slug is UNINDEXED in the FTS table, so WHERE slug = ? scans (~18 ms). Slugs are unique, so
// resolve slug -> rowid once and use rowid lookups (~0.1-0.4 ms) for single-doc snippets.
const rowidBySlug = new Map<string, number>(
  (db.query('SELECT rowid, slug FROM docs').all() as { rowid: number; slug: string }[]).map((r) => [
    r.slug,
    r.rowid,
  ]),
);
const snippetRegex = (q: string, re: boolean) => {
  try {
    const words = re ? [q] : tokens(q);
    if (!words.length) return null;
    return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
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
const snippetAt = (slug: string, text: string, rx: RegExp) => {
  const index = bodyMatch(slug, text, rx);
  if (index < 0) logger.debug('no body match for snippet', { slug, textLength: text.length });
  return index >= 0 ? text.slice(Math.max(0, index - 80), index + 200) : undefined;
};
// Constant-time snippet for ONE doc (used by /detail); same text/offsets as fullSnippets().
function docSnippet(d: Doc, q: string, re: boolean) {
  const rowid = rowidBySlug.get(d.slug);
  const rx = snippetRegex(q, re);
  if (rowid === undefined || !rx) return undefined;
  try {
    const row = re
      ? db.query('SELECT text FROM docs WHERE rowid = ?').get(rowid)
      : db.query('SELECT text FROM docs WHERE docs MATCH ? AND rowid = ?').get(
          tokens(q)
            .map((w) => `\"${w.replaceAll('\"', '\"\"')}\"*`)
            .join(' AND '),
          rowid,
        );
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
  let rx: RegExp;
  try {
    const words = re ? [q] : tokens(q);
    if (!words.length) return snippets;
    rx = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  } catch (error) {
    logger.warning('PDF-text search pattern is invalid', { query: q, regex: re, error });
    return snippets;
  }
  const rows = fullRows(q, cat, re);
  for (const r of rows) {
    const index = bodyMatch(r.slug, r.text, rx);
    if (index >= 0) snippets.set(r.slug, r.text.slice(Math.max(0, index - 80), index + 200));
  }
  const noiseOnly = rows.length - snippets.size;
  logger.debug('PDF-text snippets extracted', {
    queryLength: q.length,
    category: cat || undefined,
    regex: re,
    scanned: rows.length,
    withBodyMatch: snippets.size,
    noiseOnly,
    ms: +(performance.now() - started).toFixed(2),
  });
  if (rows.length > 0 && snippets.size === 0)
    logger.warning('every PDF-text match was a table of contents or embedded data', {
      queryLength: q.length,
      scanned: rows.length,
    });
  return snippets;
}
function highlightSnippet(s: string, q: string, re: boolean) {
  if (re) {
    try {
      const rx = new RegExp(q, 'gi');
      let out = '';
      let last = 0;
      for (const m of s.matchAll(rx)) {
        const index = m.index ?? 0;
        out += esc(s.slice(last, index)) + `<mark>${esc(m[0])}</mark>`;
        last = index + m[0].length;
      }
      return out + esc(s.slice(last));
    } catch {}
  }
  return highlight(s, tokens(q));
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
  for (const d of match) for (let n: Doc | null = d; n; n = n.parent) ids.add(n.id);
  return ids;
}

function rowFiltered(
  d: Doc,
  level: number,
  ids: Set<number>,
  snippets = new Map<string, string>(),
  q = '',
  re = false,
): string {
  if (!d.children.length) {
    const body = row(d, level);
    const snippet = snippets.get(d.slug);
    if (!snippet) return body;
    return body.replace(
      '</li>',
      `<div class="sn">…${highlightSnippet(snippet, q, re)}…</div></li>`,
    );
  }
  const open = ids.has(d.id);
  const children = d.children
    .filter((c) => ids.has(c.id))
    .map((c) => rowFiltered(c, level + 1, ids, snippets, q, re))
    .join('');
  return `<li class="row suite" role="treeitem" aria-level="${level + 1}" tabindex="-1" data-slug="${esc(d.slug)}" data-preview="/detail/${esc(d.slug)}" style="padding-left:${12 + level * 22}px"><details${open ? ' open' : ''}><summary><span class="tg-sp"></span><span class="slug">${esc(d.designator)}</span><span class="title"><span class="cat suite">${esc(d.cat || 'SUITE')}</span><a href="${BASE}/doc/${esc(d.slug)}/" target="_blank" rel="noopener">${esc(d.name)}</a><span class="cnt">${count(d)} parts</span></span></summary><ul class="list" role="group">${children}</ul></details></li>`;
}
function tree(q = '', cat = '', re = false, full = false) {
  const snippets = full && q ? fullSnippets(q, cat, re) : new Map<string, string>();
  const ids = search(q, cat, re, full, full && q ? new Set(snippets.keys()) : undefined);
  return roots.map((d) => (ids.has(d.id) ? rowFiltered(d, 0, ids, snippets, q, re) : '')).join('');
}

// First paint must not wait for JavaScript, but rendering every root row would add ~30 KB (gzip) to
// every load.  So the first screenful is rendered here, byte-for-byte what app.ts's row() produces
// for the same data (tests/prefetch.spec.ts asserts it), and app.ts renders the full tree after
// parsing, replacing identical markup, so nothing shifts.
function initialRow(d: Doc): string {
  const suite = d.children.length > 0;
  const n = d.children.length;
  const v = versions[d.slug]?.length || 0;
  const tail = suite
    ? `<span class="cnt">${n} part${n === 1 ? '' : 's'}</span>`
    : v
      ? `<span class="cnt">${v} version${v === 1 ? '' : 's'}</span>`
      : '';
  const cat = `<span class="cat${suite ? ' suite' : ''}">${esc(d.cat || (suite ? 'SUITE' : ''))}</span>`;
  const href = `${BASE}/doc/${encodeURIComponent(d.slug)}/`;
  const children = suite
    ? `<ul class="list" role="group" data-children-for="${esc(d.slug)}"></ul>`
    : '<ul class="versions"></ul>';
  return `<li class="row${suite ? ' suite' : ''}" role="treeitem" aria-level="1" tabindex="-1" data-slug="${esc(d.slug)}" data-id="${d.id}" data-preview="/detail/${esc(d.slug)}" style="padding-left:12px"><details><summary><span class="tg-sp"></span><span class="slug">${esc(d.designator)}</span><span class="title">${cat}<a href="${esc(href)}" target="_blank" rel="noopener">${esc(d.name)}</a>${tail}</span></summary>${children}</details></li>`;
}
const SSR_ROWS = 30;
const initialTree = roots.slice(0, SSR_ROWS).map(initialRow).join('');

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
  database: '.data/searchindex.sqlite',
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
          ms: +(performance.now() - started).toFixed(2),
        });
      } catch (error) {
        logger.error('page rebuild failed', {
          ms: +(performance.now() - started).toFixed(2),
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
    ms: +(performance.now() - started).toFixed(2),
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
      const ms = +(performance.now() - started).toFixed(2);

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
        ms: +(performance.now() - started).toFixed(2),
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
      queryLength: q.length,
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
      ms: +(performance.now() - started).toFixed(2),
    });

    return htmlResponse(req, result, SHORT);
  }

  if (u.pathname.startsWith('/versions/')) {
    const slug = decode(u.pathname.slice(10));
    if (slug === null) return bad();
    const d = bySlug.get(slug);
    return d ? html(req, versionRows(d), SHORT) : notFound();
  }
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

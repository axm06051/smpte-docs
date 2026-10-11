// The /search route: filter the catalog (titles in memory, or PDF text via fulltext.ts) and render
// the matching tree.
import { docs, pdfUrl, roots } from '../catalog';
import type { SearchDoc } from '../catalog/doc';
import { docUrl } from '../catalog/doc';
import { htmlResponse, packed, SHORT } from '../platform/http';
import { logger, since } from '../platform/logger';
import { esc, tokens } from '../platform/text';
import { fullSnippets, highlightSnippet } from './fulltext';
import { cnt, rowHtml } from './render';

const allDocIds = new Set(docs.map((d) => d.id));
const autocompleteText = docs.map((d) => `${d.designator} ${d.title} ${d.slug}`.toLowerCase());
export const searchIndex = new Map<string, number[]>();
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

const counts: number[] = [];
const count = (d: SearchDoc): number =>
  (counts[d.id] ??= d.children.reduce((n, id) => n + 1 + count(docs[id]), 0));

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

export function searchRoute(req: Request, u: URL) {
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

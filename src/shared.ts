// Code used by both the page (app.ts, bundled for the browser) and the server (server.ts, mcp.ts).
// Keep it free of Bun/Node imports: the browser bundles it and the tests import it under Node.
//
// The server renders the first screenful of rows and the /detail fragments with these same
// functions, so what it sends is byte-for-byte what the client would have rendered (no layout shift).

export type SearchDoc = {
  id: number; // also the index in the docs array, so docs[d.parent] is the parent (docs[-1] is undefined)
  slug: string;
  title: string;
  name: string;
  designator: string;
  cat: string;
  parent: number;
  children: number[];
  versions: number;
};

export const BASE = 'https://pub.smpte.org';
export const docUrl = (slug: string) => `${BASE}/doc/${encodeURIComponent(slug)}/`;

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
export const escRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const pl = (n: number) => (n === 1 ? '' : 's');
export const tokens = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// Wrap every match of the (global) regex in <mark>; everything else is escaped.
export function mark(text: string, re: RegExp) {
  let out = '',
    last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    out += esc(text.slice(last, i)) + `<mark>${esc(m[0])}</mark>`;
    last = i + m[0].length;
  }
  return out + esc(text.slice(last));
}
// `wordStart` anchors each word at a word boundary (the server's PDF-text snippets).
export const highlight = (text: string, words: string[], wordStart = false) =>
  words.length
    ? mark(text, new RegExp(`${wordStart ? '\\b' : ''}(${words.map(escRe).join('|')})`, 'gi'))
    : esc(text);

export const cnt = (n: number, word: string) => `<span class="cnt">${n} ${word}${pl(n)}</span>`;

// The small card shown for a document (autocomplete preview and the /detail fragment).
export function previewHtml(d: SearchDoc, docs: SearchDoc[]) {
  const crumbs: string[] = [];
  for (let p = docs[d.parent]; p; p = docs[p.parent]) crumbs.unshift(p.designator);
  const parent = docs[d.parent];
  const n = d.children.length;
  const meta = (html: string) => `<div class="pv-meta">${html}</div>`;
  let body = `<div class="pv-top"><span class="cat">${esc(d.cat)}</span><span class="pv-des">${esc(d.designator)}</span></div><div class="pv-title">${esc(d.name)}</div>`;
  if (crumbs.length) body += meta(`Suite: <b>${esc(crumbs.join(' › '))}</b>`);
  if (parent)
    body += meta(
      `Part ${parent.children.indexOf(d.id) + 1} of ${parent.children.length} in ${esc(parent.designator)}`,
    );
  if (n) {
    const first = d.children
      .slice(0, 5)
      .map((id) => esc(docs[id].designator))
      .join(', ');
    body += meta(`<b>${n}</b> part${pl(n)}: ${first}${n > 5 ? ` &hellip; +${n - 5} more` : ''}`);
  }
  if (d.versions) body += meta(`<b>${d.versions}</b> dated version${pl(d.versions)}`);
  return (
    body +
    meta(
      `<a href="${BASE}/doc/${esc(d.slug)}/" target="_blank" rel="noopener">Open document page &#8599;</a>`,
    )
  );
}

type RowParts = {
  href: string;
  name: string; // already HTML
  tail: string; // already HTML: the "N parts" / "N versions" badge
  kids: string; // already HTML: the nested <ul>
  open?: boolean;
  id?: boolean; // emit data-id (rows the client hydrates lazily need it)
  extra?: string; // already HTML, placed after the <details>
};
// The one tree-row shell.  Callers differ only in what goes in the slots above.
export function rowHtml(d: SearchDoc, level: number, p: RowParts) {
  const suite = d.children.length > 0;
  return `<li class="row${suite ? ' suite' : ''}" role="treeitem" aria-level="${level + 1}" tabindex="-1" data-slug="${esc(d.slug)}"${p.id ? ` data-id="${d.id}"` : ''} data-preview="/detail/${esc(d.slug)}" style="padding-left:${12 + level * 22}px"><details${p.open ? ' open' : ''}><summary><span class="tg-sp"></span><span class="slug">${esc(d.designator)}</span><span class="title"><span class="cat${suite ? ' suite' : ''}">${esc(d.cat || (suite ? 'SUITE' : ''))}</span><a href="${esc(p.href)}" target="_blank" rel="noopener">${p.name}</a>${p.tail}</span></summary>${p.kids}</details>${p.extra ?? ''}</li>`;
}

// A row whose children (suites) or version list (leaves) are filled in lazily by the client.
export const treeRow = (d: SearchDoc, level: number, words: string[] = [], open = false) => {
  const suite = d.children.length > 0;
  return rowHtml(d, level, {
    id: true,
    open,
    href: docUrl(d.slug),
    name: highlight(d.name, words),
    tail: suite ? cnt(d.children.length, 'part') : d.versions ? cnt(d.versions, 'version') : '',
    kids: suite
      ? `<ul class="list" role="group" data-children-for="${esc(d.slug)}"></ul>`
      : '<ul class="versions"></ul>',
  });
};

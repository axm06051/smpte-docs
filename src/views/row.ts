// Tree-row markup and text highlighting.  Used by the server (first paint, /search) and bundled into
// the browser (client/app.ts), so it must stay free of Bun/Node imports.  The server's first screenful
// is rendered with these same functions, so what it sends is byte-for-byte what the client renders.
import { docUrl, type SearchDoc } from '../catalog/doc';
import { esc, escRe, pl, tokens } from '../platform/text';

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

// A PDF-text snippet: regex mode highlights the pattern itself, otherwise the query's words.
export function highlightSnippet(s: string, q: string, re: boolean) {
  if (re) {
    try {
      return mark(s, new RegExp(q, 'gi'));
    } catch {}
  }
  return highlight(s, tokens(q), true);
}

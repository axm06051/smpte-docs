// A row of the /search result tree.  Server-only (it reads the catalog), unlike views/row.ts.
import { docs, pdfUrl } from '../catalog';
import { docUrl, type SearchDoc } from '../catalog/doc';
import { esc } from '../platform/text';
import { cnt, highlightSnippet, rowHtml } from './row';

const counts: number[] = [];
const count = (d: SearchDoc): number =>
  (counts[d.id] ??= d.children.reduce((n, id) => n + 1 + count(docs[id]), 0));

// Unlike the lazily hydrated rows (row.ts treeRow) the whole subtree is
// rendered, suites are open, leaves link straight to their PDF, and a PDF-text hit adds its snippet.
export function rowFiltered(
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

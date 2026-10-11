// The small card shown for a document: the autocomplete preview and the /detail fragment.
import { BASE, type SearchDoc } from '../catalog/doc';
import { esc, pl } from '../platform/text';

export const pvMeta = (html: string) => `<div class="pv-meta">${html}</div>`;

export function previewHtml(d: SearchDoc, docs: SearchDoc[]) {
  const crumbs: string[] = [];
  for (let p = docs[d.parent]; p; p = docs[p.parent]) crumbs.unshift(p.designator);
  const parent = docs[d.parent];
  const n = d.children.length;
  let body = `<div class="pv-top"><span class="cat">${esc(d.cat)}</span><span class="pv-des">${esc(d.designator)}</span></div><div class="pv-title">${esc(d.name)}</div>`;
  if (crumbs.length) body += pvMeta(`Suite: <b>${esc(crumbs.join(' › '))}</b>`);
  if (parent)
    body += pvMeta(
      `Part ${parent.children.indexOf(d.id) + 1} of ${parent.children.length} in ${esc(parent.designator)}`,
    );
  if (n) {
    const first = d.children
      .slice(0, 5)
      .map((id) => esc(docs[id].designator))
      .join(', ');
    body += pvMeta(`<b>${n}</b> part${pl(n)}: ${first}${n > 5 ? ` &hellip; +${n - 5} more` : ''}`);
  }
  if (d.versions) body += pvMeta(`<b>${d.versions}</b> dated version${pl(d.versions)}`);
  return (
    body +
    pvMeta(
      `<a href="${BASE}/doc/${esc(d.slug)}/" target="_blank" rel="noopener">Open document page &#8599;</a>`,
    )
  );
}

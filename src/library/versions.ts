// The /versions/<slug> route: the dated editions listed under a document.
import { bySlug, pdfUrls, versions } from '../catalog';
import { BASE, type SearchDoc } from '../catalog/doc';
import { bad, decode, html, notFound, SHORT } from '../platform/http';
import { esc } from '../platform/text';

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

export function versionsRoute(req: Request, u: URL) {
  const slug = decode(u.pathname.slice(10));
  if (slug === null) return bad();
  const d = bySlug.get(slug);
  return d ? html(req, versionRows(d), SHORT) : notFound();
}

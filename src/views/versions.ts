// The dated editions listed under a document (the /versions fragment).
import { BASE, type SearchDoc } from '../catalog/doc';
import { esc } from '../platform/text';

export type Version = string | { k?: string; s?: string };

export function versionItems(d: SearchDoc, list: Version[], pdfUrls: Record<string, string>) {
  return list
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

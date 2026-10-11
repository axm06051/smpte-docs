// The /detail/<slug> route: the preview card for one document, optionally with a PDF-text snippet.
import { bySlug, docs } from '../catalog';
import type { SearchDoc } from '../catalog/doc';
import { bad, decode, html, notFound, SHORT } from '../platform/http';
import { logger } from '../platform/logger';
import { docSnippet, highlightSnippet } from './fulltext';
import { previewHtml } from './render';

function detailPreview(d: SearchDoc, q = '', re = false, full = false) {
  let body = previewHtml(d, docs);
  if (full && q) {
    const snippet = docSnippet(d, q, re);
    if (snippet) body += `<div class="pv-meta">…${highlightSnippet(snippet, q, re)}…</div>`;
  }
  return body;
}

export function detailRoute(req: Request, u: URL) {
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

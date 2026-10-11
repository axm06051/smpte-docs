// The /detail/<slug> route: the preview card for one document, optionally with a PDF-text snippet.
import { docs } from '../catalog';
import { SHORT } from '../platform/http';
import { previewHtml, pvMeta } from '../views/preview';
import { highlightSnippet } from '../views/row';
import { docSnippet } from './fulltext';
import { docFragment } from './fragment';

export const detailRoute = (req: Request, u: URL) =>
  docFragment(req, u, '/detail/', (d) => {
    const q = u.searchParams.get('q') || '';
    const re = u.searchParams.get('re') === '1';
    const full = q !== '' && u.searchParams.get('full') === '1';
    let body = previewHtml(d, docs);
    const snippet = full ? docSnippet(d, q, re) : undefined;
    if (snippet) body += pvMeta(`…${highlightSnippet(snippet, q, re)}…`);
    // The fragment only depends on q/re when a PDF-text snippet is requested; otherwise it is
    // immutable until restart, so let the browser (and the prefetcher) reuse it.
    return [body, full ? '' : SHORT];
  });

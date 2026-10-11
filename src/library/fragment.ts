// The two per-document fragment routes (/detail/<slug>, /versions/<slug>) share their lookup:
// decode the slug, find the document, 400 / 404 otherwise.  `make` returns the body and its cache policy.
import { bySlug } from '../catalog';
import type { SearchDoc } from '../catalog/doc';
import { bad, decode, html, notFound, SHORT } from '../platform/http';
import { logger } from '../platform/logger';

export function docFragment(
  req: Request,
  u: URL,
  prefix: string,
  make: (d: SearchDoc) => string | [body: string, cacheControl: string],
) {
  const slug = decode(u.pathname.slice(prefix.length));
  if (slug === null) {
    logger.warning('invalid fragment URL encoding', { path: u.pathname });
    return bad();
  }
  const d = bySlug.get(slug);
  if (!d) {
    logger.debug('fragment document not found', { prefix, slug });
    return notFound();
  }
  const made = make(d);
  return typeof made === 'string' ? html(req, made, SHORT) : html(req, made[0], made[1]);
}

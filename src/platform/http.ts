// Response plumbing shared by every route: content negotiation, compression, validators, a bounded
// cache of rendered fragments. Knows nothing about SMPTE documents.
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { logger, since } from './logger';

// ---- Compression + validators ------------------------------------------------------------------
// Everything that is compressed more than once is compressed once, at startup or first use.
type Enc = 'br' | 'gzip' | '';
export type Bytes = Uint8Array<ArrayBuffer>;
export const PROD = process.env.NODE_ENV === 'production';
const negotiate = (req: Request): Enc => {
  const h = req.headers.get('accept-encoding') ?? '';
  return /\bbr\b/.test(h) ? 'br' : /\bgzip\b/.test(h) ? 'gzip' : '';
};
const brotli = (b: string | Uint8Array, quality: number): Bytes =>
  new Uint8Array(brotliCompressSync(b, { params: { [zlib.BROTLI_PARAM_QUALITY]: quality } }));
export const digest = (b: string | Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(b).digest('hex').slice(0, 10);

// A fully prepared response body: raw + both encodings + a weak validator (weak because the bytes
// differ per Content-Encoding even though the representation is the same).
export type Blob = { raw: Bytes; gz: Bytes; br: Bytes; etag: string; type: string };
export function makeBlob(raw: Bytes, type: string, gz?: Bytes): Blob {
  return {
    raw,
    gz: gz ?? Bun.gzipSync(raw, { level: 9 }),
    br: brotli(raw, PROD ? 11 : 5),
    etag: `W/"${digest(raw)}"`,
    type,
  };
}
export function serveBlob(req: Request, a: Blob, cc: string) {
  const headers: Record<string, string> = {
    'content-type': a.type,
    'cache-control': cc,
    etag: a.etag,
    vary: 'accept-encoding',
  };
  if (req.headers.get('if-none-match') === a.etag)
    return new Response(null, { status: 304, headers });
  const enc = negotiate(req);
  if (!enc) return new Response(a.raw, { headers });
  headers['content-encoding'] = enc;
  return new Response(enc === 'br' ? a.br : a.gz, { headers });
}

export const SHORT = 'public, max-age=300';
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
export const bad = () => new Response('bad request', { status: 400 });
export const notFound = () => new Response('not found', { status: 404 });

// Fragments: compressed only when the client accepts it and the body is big enough to pay for it.
// Validators let an expired entry revalidate with a 304 instead of re-sending the body.
type Packed = { raw: string; gz?: Bytes; br?: Bytes; etag?: string; live?: boolean };
export function htmlResponse(req: Request, p: Packed, cc = '') {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    vary: 'accept-encoding',
  };
  if (cc) {
    p.etag ??= `W/"${Bun.hash(p.raw).toString(36)}"`;
    headers['cache-control'] = cc;
    headers.etag = p.etag;
    if (req.headers.get('if-none-match') === p.etag)
      return new Response(null, { status: 304, headers });
  }
  const enc = p.raw.length < 1024 ? '' : negotiate(req);
  if (!enc) return new Response(p.raw, { headers });
  if (enc === 'br' ? !p.br : !p.gz) {
    const z = enc === 'br' ? (p.br = brotli(p.raw, 4)) : (p.gz = Bun.gzipSync(p.raw, { level: 4 }));
    if (p.live) cacheBytes += z.length;
  }
  headers['content-encoding'] = enc;
  return new Response(enc === 'br' ? p.br : p.gz, { headers });
}
export const html = (req: Request, body: string, cc = '') => htmlResponse(req, { raw: body }, cc);

// Bounded LRU for the expensive /search fragments: a repeat query costs a Map hit, not an FTS scan,
// and each encoding is computed once per entry.
const MAX_ENTRIES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
const packedCache = new Map<string, Packed>();
let cacheBytes = 0;
export function packed(key: string, make: () => string): Packed {
  const started = performance.now();
  const hit = packedCache.get(key);
  if (hit) {
    packedCache.delete(key);
    packedCache.set(key, hit);
    logger.debug('search fragment cache hit', {
      entries: packedCache.size,
      cacheBytes,
    });
    return hit;
  }
  logger.debug('search fragment cache miss', {
    entries: packedCache.size,
    cacheBytes,
  });
  const p: Packed = { raw: make(), live: true };
  packedCache.set(key, p);
  cacheBytes += p.raw.length;
  let evicted = 0;
  for (const [k, v] of packedCache) {
    if (packedCache.size <= MAX_ENTRIES && cacheBytes <= MAX_BYTES) break;
    packedCache.delete(k);
    v.live = false;
    cacheBytes -= v.raw.length + (v.gz?.length ?? 0) + (v.br?.length ?? 0);
    evicted++;
  }
  logger.trace('search fragment rendered', {
    htmlBytes: p.raw.length,
    entries: packedCache.size,
    cacheBytes,
    evicted,
    ms: since(started),
  });

  return p;
}

// The document model: every SMPTE document, its suite tree, dated versions and PDF links.
// Built once at startup from catalog/data.ts plus the .data/*.json files the indexer writes.
import RAW from './data';
import { BASE, type SearchDoc } from './doc';
import { logger } from '../platform/logger';

export type Version = string | { k?: string; s?: string };
type PdfUrls = Record<string, string>;
export type Versions = Record<string, Version[]>;

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const value = (await Bun.file(path).json()) as T;
    logger.debug('metadata file loaded', { path });
    return value;
  } catch (error) {
    logger.warning('metadata file unavailable; using fallback', {
      path,
      error,
    });
    return fallback;
  }
}

export const versions = await loadJson<Versions>('.data/versions.json', {});
export const pdfUrls = await loadJson<PdfUrls>('.data/pdf-urls.json', {});

const pdfBySlug = new Map<string, string>();
for (const [path, url] of Object.entries(pdfUrls)) {
  const match =
    path.match(/^\/doc\/([^/]+)\/.*\.pdf$/i) || path.match(/^\/latest\/([^/]+)\/.*\.pdf$/i);
  if (match && !pdfBySlug.has(match[1])) pdfBySlug.set(match[1], url);
}

// One doc shape for the whole app: it is exactly what the page receives as JSON, and what the
// shared render functions take, so server and client markup cannot drift apart.
export const docs: SearchDoc[] = RAW.map(([slug, title], id) => {
  const designator = title.split(',')[0].trim();
  const m = /^(OV|RP|EG|RDD|ST)?\s*([0-9]+(?:\.[0-9]+)?(?:-[0-9]+)?)/.exec(title);
  return {
    id,
    slug,
    title,
    name: title.slice(designator.length).replace(/^\s*,\s*/, '') || title,
    designator,
    cat: m?.[1] || '',
    parent: -1,
    children: [],
    versions: versions[slug]?.length || 0,
  };
});

export const bySlug = new Map(docs.map((d) => [d.slug, d]));
RAW.forEach(([, , parentSlug], id) => {
  const parent = parentSlug ? bySlug.get(parentSlug) : undefined;
  if (parent && parent.id !== id) {
    docs[id].parent = parent.id;
    parent.children.push(id);
  }
});

const nums = docs.map((d) => (d.designator.match(/\d+/g) || []).map(Number));
const cmp = (a: SearchDoc, b: SearchDoc) => {
  const x = nums[a.id],
    y = nums[b.id];
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] ?? -1) - (y[i] ?? -1);
  return a.slug.localeCompare(b.slug);
};
export const roots = docs.filter((d) => d.parent < 0).sort(cmp);
for (const d of docs) d.children.sort((a, b) => cmp(docs[a], docs[b]));

export const searchData = JSON.stringify(docs).replaceAll('<', '\\u003c');

export const pdfUrl = (d: SearchDoc) => pdfBySlug.get(d.slug) || `${BASE}/doc/${d.slug}/`;

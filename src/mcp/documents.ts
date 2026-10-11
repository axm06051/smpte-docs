// Reading side of the MCP slice: slug resolution, extracted text, passages around a term.
import { bySlug } from '../catalog';
import { db, rowIds } from '../platform/db';
import { logger } from '../platform/logger';
import { noiseReason } from '../platform/toc';

export const baseOf = (slug: string) => slug.split('_')[0];
export const titleOf = (slug: string) => bySlug.get(baseOf(slug))?.title ?? slug;
export const editionsByBase = new Map<string, string[]>();
for (const slug of rowIds.keys()) {
  if (!slug.includes('_')) continue;
  const list = editionsByBase.get(baseOf(slug)) ?? [];
  list.push(slug);
  editionsByBase.set(baseOf(slug), list);
}

export const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Accepts "st2110-21", "ST 2110-21", an edition slug, or an smpte:// path segment. */
export const resolveSlug = (input: string) => {
  let s = input.trim().toLowerCase();
  try {
    s = decodeURIComponent(s);
  } catch {}
  for (const candidate of [s, s.replace(/\s+/g, '')]) if (rowIds.has(candidate)) return candidate;
  const base = baseOf(s.replace(/\s+/g, ''));
  if (rowIds.has(base)) return base;
  return editionsByBase.get(base)?.[0];
};

export const readText = (slug: string) => {
  const id = rowIds.get(slug);
  if (!id) return null;
  const row = db.query('SELECT text FROM docs WHERE rowid = ?').get(id) as { text: string } | null;
  return row?.text ?? null;
};

export const passagesFor = (text: string, needle: string, max = 5, radius = 600) => {
  const low = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: { at: number; text: string }[] = [];
  let i = 0;
  while (out.length < max && (i = low.indexOf(n, i)) >= 0) {
    const chunk = text.slice(Math.max(0, i - radius), i + n.length + radius);
    const reason = noiseReason(text.slice(Math.max(0, i - 200), i + 200));
    if (reason) logger.trace('MCP passage skipped as noise', { needle: n, reason, at: i });
    else out.push({ at: i, text: clean(chunk) });
    i += radius * 2;
  }
  return out;
};

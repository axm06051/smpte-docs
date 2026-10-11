// The search_smpte tool's engine: title/designator matching merged with FTS5 body-text ranking.
import { docs } from '../catalog';
import { BASE } from '../catalog/doc';
import { db, rowIds } from '../platform/db';
import { logger, since } from '../platform/logger';
import { tokens as wordsOf } from '../platform/text';
import { noiseReason } from '../platform/toc';
import {
  baseOf,
  clean,
  editionsByBase,
  passagesFor,
  readText,
  resolveSlug,
  titleOf,
} from './documents';

// Like the page's tokens(), but a bare "-" is not a search term.
const tokens = (q: string) => wordsOf(q).filter((w) => /[a-z0-9]/.test(w));

const STOP = new Set(
  'a an and are as at be by can do does for from how i in is it my of on or that the this to what when where which why with'.split(
    ' ',
  ),
);
const terms = (q: string) => {
  const all = tokens(q);
  const kept = all.filter((w) => !STOP.has(w));
  return kept.length ? kept : all;
};

const fts = (words: string[], op: 'AND' | 'OR') => words.map((w) => `"${w}"*`).join(` ${op} `);

// Title/designator index so "ST 2110-21" or "traffic shaping" finds the right spec
// even when body-text ranking prefers a document that merely mentions it.
const isMatch = (set: Set<string>, w: string) =>
  set.has(w) || (w.length >= 3 && [...set].some((t) => t.startsWith(w)));
const titleIndex = docs.map(({ slug, title }) => ({
  slug,
  title,
  designator: new Set(tokens(`${title.split(',')[0]} ${slug}`)),
  all: new Set(tokens(`${title} ${slug}`)),
}));

export type Hit = {
  slug: string;
  title: string;
  uri: string;
  url: string;
  snippet: string;
  editions: string[];
  via: 'title' | 'text';
};

// FTS snippet() picks the densest region, which is often the TOC; fall back to the first body match.
const bodySnippet = (slug: string, fts: string, words: string[]) => {
  const reason = noiseReason(fts);
  if (!reason) return fts;
  logger.debug('MCP snippet is noise; looking for a body passage', { slug, reason });
  const text = readText(slug);
  if (text === null) {
    logger.warning('MCP snippet fallback skipped: document text unavailable', { slug });
    return fts;
  }
  for (const w of words) {
    const [p] = passagesFor(text, w, 1, 150);
    if (p) {
      logger.trace('MCP snippet replaced by body passage', { slug, term: w, at: p.at });
      return p.text;
    }
  }
  logger.warning('MCP snippet fallback found no body passage; returning noisy snippet', {
    slug,
    terms: words.length,
  });
  return fts;
};

const passage = (slug: string, words: string[]) => {
  const id = rowIds.get(slug);
  if (!id) return '';
  const row = db
    .query(
      `SELECT snippet(docs, 1, '«', '»', ' … ', 48) AS s FROM docs WHERE docs MATCH ? AND rowid = ?`,
    )
    .get(fts(words, 'OR'), id) as { s: string } | null;
  return clean(row?.s || (readText(slug) ?? '').slice(0, 300));
};

const makeHit = (slug: string, snippet: string, via: Hit['via']): Hit => ({
  slug,
  title: titleOf(slug),
  uri: `smpte://doc/${encodeURIComponent(slug)}`,
  url: `${BASE}/doc/${encodeURIComponent(slug)}/`,
  snippet,
  editions: editionsByBase.get(slug) ?? [],
  via,
});

export const searchDocs = (q: string, limit: number): Hit[] => {
  const started = performance.now();
  const words = terms(q);

  logger.trace('SMPTE search tokenized', {
    termCount: words.length,
    limit,
  });

  if (!words.length) {
    logger.debug('SMPTE search produced no tokens', { query: q });
    return [];
  }

  const hits = new Map<string, Hit>();

  const need = words.length === 1 ? 1 : Math.max(2, Math.ceil(words.length / 2));
  titleIndex
    .map((d) => ({
      d,
      hit: words.filter((w) => isMatch(d.all, w)).length,
      desig: words.filter((w) => isMatch(d.designator, w)).length,
    }))
    .filter((x) => x.hit >= need)
    .sort((a, b) => b.desig - a.desig || b.hit - a.hit || a.d.title.length - b.d.title.length)
    .slice(0, Math.min(5, limit))
    .forEach(({ d }) => hits.set(d.slug, makeHit(d.slug, '', 'title')));

  const run = (match: string) =>
    db
      .query(
        `SELECT slug, snippet(docs, 1, '«', '»', ' … ', 48) AS s
         FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT ?`,
      )
      .all(match, limit * 4) as { slug: string; s: string }[];

  let rows = run(fts(words, 'AND'));
  logger.trace('SMPTE full-text query completed', {
    strategy: 'AND',
    rows: rows.length,
    ms: since(started),
  });

  if (!rows.length && words.length > 1) {
    logger.debug('SMPTE search using OR fallback', {
      query: q,
      terms: words.length,
    });

    rows = run(fts(words, 'OR'));
  }

  for (const row of rows) {
    const base = baseOf(row.slug);
    const existing = hits.get(base);
    if (existing) {
      if (!existing.snippet) existing.snippet = bodySnippet(row.slug, clean(row.s), words);
    } else if (hits.size < limit) {
      hits.set(base, makeHit(base, bodySnippet(row.slug, clean(row.s), words), 'text'));
    }
  }

  for (const hit of hits.values()) {
    if (!hit.snippet) hit.snippet = passage(resolveSlug(hit.slug) ?? hit.slug, words);
  }
  return [...hits.values()];
};

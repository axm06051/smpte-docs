// "PDF text" search: FTS5 over the extracted document text, plus the snippet shown for each hit.
import { docs } from '../catalog';
import type { SearchDoc } from '../catalog/doc';
import { db, rowIds } from '../platform/db';
import { logger, since } from '../platform/logger';
import { escRe, tokens } from '../platform/text';
import { firstBodyMatch } from '../platform/toc';

const fullSlugs = new Map<string, string[]>();
for (const d of docs) {
  const slugs = fullSlugs.get(d.cat);
  if (slugs) slugs.push(d.slug);
  else fullSlugs.set(d.cat, [d.slug]);
}
const inList = (slugs: string[]) => `slug IN (${slugs.map(() => '?').join(',')})`;
const fullQueries = new Map([...fullSlugs].map(([cat, slugs]) => [cat, inList(slugs)]));
// FTS5 prefix query: every word must match.
const ftsAnd = (q: string) =>
  tokens(q)
    .map((w) => `"${w.replaceAll('"', '""')}"*`)
    .join(' AND ');
type TextRow = { slug: string; text: string };

// Streamed: a regex search visits every document, and holding all their text at once is hundreds
// of MB.  The slug filter is only needed for one category (every document is "all").
function* fullRows(q: string, cat: string, re: boolean): Generator<TextRow> {
  const slugs = cat ? fullSlugs.get(cat) || [] : [];
  const where = cat ? ` AND ${fullQueries.get(cat) || '0'}` : '';
  if (re) {
    yield* db
      .query(`SELECT slug, text FROM docs WHERE 1${where}`)
      .iterate(...slugs) as Iterable<TextRow>;
    return;
  }
  const match = ftsAnd(q);
  if (!match) return;
  yield* db
    .query(`SELECT slug, text FROM docs WHERE docs MATCH ?${where}`)
    .iterate(match, ...slugs) as Iterable<TextRow>;
}

const snippetRegex = (q: string, re: boolean) => {
  try {
    const words = re ? [q] : tokens(q);
    if (!words.length) return null;
    return new RegExp(words.map(escRe).join('|'), 'i');
  } catch (error) {
    logger.warning('PDF-text snippet pattern is invalid', { query: q, regex: re, error });
    return null;
  }
};

// First match outside a TOC / embedded binary. Each rejected match is traced so a missing or
// surprising snippet can be explained from the log.
const bodyMatch = (slug: string, text: string, rx: RegExp) =>
  firstBodyMatch(text, rx, (reason, at) =>
    logger.trace('PDF-text match skipped as noise', { slug, reason, at }),
  );
const around = (text: string, index: number) => text.slice(Math.max(0, index - 80), index + 200);
const snippetAt = (slug: string, text: string, rx: RegExp) => {
  const index = bodyMatch(slug, text, rx);
  if (index < 0) logger.debug('no body match for snippet', { slug, textLength: text.length });
  return index >= 0 ? around(text, index) : undefined;
};
// Constant-time snippet for ONE doc (used by /detail); same text/offsets as fullSnippets().
export function docSnippet(d: SearchDoc, q: string, re: boolean) {
  const rowid = rowIds.get(d.slug);
  const rx = snippetRegex(q, re);
  if (rowid === undefined || !rx) return undefined;
  try {
    const row = re
      ? db.query('SELECT text FROM docs WHERE rowid = ?').get(rowid)
      : db.query('SELECT text FROM docs WHERE docs MATCH ? AND rowid = ?').get(ftsAnd(q), rowid);
    return row ? snippetAt(d.slug, (row as { text: string }).text, rx) : undefined;
  } catch (error) {
    // A broken snippet must not turn the whole preview into a 500.
    logger.error('PDF-text snippet lookup failed', { slug: d.slug, query: q, regex: re, error });
    return undefined;
  }
}

export function fullSnippets(q: string, cat: string, re: boolean) {
  const started = performance.now();
  const snippets = new Map<string, string>();
  const rx = snippetRegex(q, re);
  if (!rx) return snippets;
  const scan = new RegExp(rx.source, rx.flags + 'g'); // compiled once for every document
  let scanned = 0;
  for (const r of fullRows(q, cat, re)) {
    scanned++;
    const index = bodyMatch(r.slug, r.text, scan);
    if (index >= 0) snippets.set(r.slug, around(r.text, index));
  }
  const noiseOnly = scanned - snippets.size;
  logger.debug('PDF-text snippets extracted', {
    query: q,
    category: cat || undefined,
    regex: re,
    scanned,
    withBodyMatch: snippets.size,
    noiseOnly,
    ms: since(started),
  });
  if (scanned > 0 && snippets.size === 0)
    logger.warning('every PDF-text match was a table of contents or embedded data', {
      query: q,
      scanned,
    });
  return snippets;
}

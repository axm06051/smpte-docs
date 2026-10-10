import { timingSafeEqual } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { createMcpHandler, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import RAW from './catalog';
import { logger } from './logger';
import { noiseReason } from './toc';

const DB_PATH = '.data/searchindex.sqlite';
const db = (() => {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch (error) {
    logger.fatal('search index cannot be opened; build it with `bun run index`', {
      path: DB_PATH,
      error,
    });
    throw error;
  }
})();
const docs = new Map(RAW.map(([slug, title]) => [slug, title]));
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const BASE = 'https://pub.smpte.org';

const resourceUri = 'ui://smpte-search/search.html';
const documentUri = 'smpte://doc/{slug}';

// The index holds one row per document ("st2110-21") and one per published edition
// ("st2110-21_st2110-21-2017"). Map every slug to its rowid so reads never scan the table.
const rowIds = new Map(
  (db.query('SELECT rowid AS id, slug FROM docs').all() as { id: number; slug: string }[]).map(
    (r) => [r.slug, r.id],
  ),
);
const baseOf = (slug: string) => slug.split('_')[0];
const titleOf = (slug: string) => docs.get(baseOf(slug)) ?? slug;
const editionsByBase = new Map<string, string[]>();
for (const slug of rowIds.keys()) {
  if (!slug.includes('_')) continue;
  const list = editionsByBase.get(baseOf(slug)) ?? [];
  list.push(slug);
  editionsByBase.set(baseOf(slug), list);
}

const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const tokens = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/.test(w));

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
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Accepts "st2110-21", "ST 2110-21", an edition slug, or an smpte:// path segment. */
const resolveSlug = (input: string) => {
  let s = input.trim().toLowerCase();
  try {
    s = decodeURIComponent(s);
  } catch {}
  for (const candidate of [s, s.replace(/\s+/g, '')]) if (rowIds.has(candidate)) return candidate;
  const base = baseOf(s.replace(/\s+/g, ''));
  if (rowIds.has(base)) return base;
  return editionsByBase.get(base)?.[0];
};

const readText = (slug: string) => {
  const id = rowIds.get(slug);
  if (!id) return null;
  const row = db.query('SELECT text FROM docs WHERE rowid = ?').get(id) as { text: string } | null;
  return row?.text ?? null;
};

// Title/designator index so "ST 2110-21" or "traffic shaping" finds the right spec
// even when body-text ranking prefers a document that merely mentions it.
const isMatch = (set: Set<string>, w: string) =>
  set.has(w) || (w.length >= 3 && [...set].some((t) => t.startsWith(w)));
const catalog = RAW.map(([slug, title]) => ({
  slug,
  title,
  designator: new Set(tokens(`${title.split(',')[0]} ${slug}`)),
  all: new Set(tokens(`${title} ${slug}`)),
}));

type Hit = {
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

const searchDocs = (q: string, limit: number): Hit[] => {
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
  catalog
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
    ms: +(performance.now() - started).toFixed(2),
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

const passagesFor = (text: string, needle: string, max = 5, radius = 600) => {
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

const authorized = (req: Request) => {
  if (!MCP_TOKEN) return true;
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${MCP_TOKEN}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'SMPTE Search', version: '1.1.0' });

  registerAppTool(
    server,
    'search_smpte',
    {
      title: 'Search SMPTE Documentation',
      description:
        'Search the SMPTE standards library (ST, RP, EG, RDD, OV) by designator, title, or any engineering text: specifications, requirements, definitions, signalling, timing, troubleshooting symptoms. Returns matching documents with relevant excerpts («matched terms») and slugs. Use read_smpte_document with a slug to read the full text or pull passages. Excerpts are extracted from PDFs, so tables and figures may be incomplete; confirm critical values against the official document at the returned URL.',
      inputSchema: z.object({
        q: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Designator (e.g. "ST 2110-21"), topic, terminology, or symptom, e.g. "traffic shaping sender" or "PTP profile"',
          ),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri } },
    },
    async ({ q, limit }) => {
      const started = performance.now();
      logger.info('SMPTE search started', { query: q, limit });

      try {
        const results = searchDocs(q, limit);
        logger.info('SMPTE search completed', {
          query: q,
          results: results.length,
          ms: +(performance.now() - started).toFixed(2),
        });

        const html = `<form data-tool="search_smpte">
  <input name="q" value="${esc(q)}" aria-label="Search SMPTE documentation" autofocus>
  <button type="submit">Search</button>
</form>
<p>${results.length} result${results.length === 1 ? '' : 's'} for <b>${esc(q)}</b></p>
<ul>
${
  results
    .map((r) => {
      const comma = r.title.indexOf(',');
      const excerpt = esc(r.snippet).replaceAll('«', '<mark>').replaceAll('»', '</mark>');
      return `<li>
  <a href="${esc(r.url)}" target="_blank" rel="noopener">
    <b>${esc(comma >= 0 ? r.title.slice(0, comma) : r.title)}</b>${esc(comma >= 0 ? r.title.slice(comma + 1) : '')}
  </a>
  <p>${excerpt}</p>
</li>`;
    })
    .join('') || '<li>No matches.</li>'
}
</ul>`;

        // Most MCP clients show the model only `content`, so the results must be in the text.
        const text = results.length
          ? [
              `Found ${results.length} SMPTE document(s) for "${q}":`,
              ...results.map(
                (r, i) =>
                  `\n${i + 1}. ${r.title}\n   slug: ${r.slug}${
                    r.editions.length ? ` (editions: ${r.editions.join(', ')})` : ''
                  }\n   ${r.url}\n   ${r.snippet.slice(0, 500)}`,
              ),
              '\nUse read_smpte_document with a slug to read more.',
            ].join('\n')
          : `No SMPTE documents matched "${q}". Try fewer or different terms, or a designator such as "ST 2110-20".`;

        return {
          content: [{ type: 'text', text }],
          structuredContent: { html, query: q, results },
        };
      } catch (error) {
        logger.error('SMPTE search failed', { query: q, limit, error });
        throw error;
      }
    },
  );

  server.registerTool(
    'read_smpte_document',
    {
      title: 'Read SMPTE Document',
      description:
        'Read the extracted text of one SMPTE document by slug (from search_smpte; "ST 2110-21" style designators also work). Large documents are paged: use offset/length, or pass `find` to get up to 5 passages around a term inside the document instead of reading it linearly. Text is lowercased PDF extraction; tables and figures may be incomplete, so confirm critical values against the official PDF.',
      inputSchema: z.object({
        slug: z.string().trim().min(1).describe('Document slug, e.g. "st2110-21"'),
        find: z
          .string()
          .trim()
          .optional()
          .describe('Return passages around this term instead of a page of text'),
        offset: z.number().int().min(0).default(0).describe('Character offset to start reading'),
        length: z.number().int().min(500).max(50000).default(20000),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ slug, find, offset, length }) => {
      const resolved = resolveSlug(slug);
      const text = resolved ? readText(resolved) : null;
      if (!resolved || text === null) {
        logger.warning('SMPTE document not found', { slug });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `No indexed text for "${slug}". Use search_smpte to find the slug, or check ${BASE}/doc/${encodeURIComponent(
                baseOf(slug.toLowerCase().replace(/\s+/g, '')),
              )}/.`,
            },
          ],
        };
      }

      const head = `# ${titleOf(resolved)}\nslug: ${resolved} | ${BASE}/doc/${encodeURIComponent(baseOf(resolved))}/ | ${text.length} characters`;
      logger.info('SMPTE document read', { slug: resolved, find, offset, length });

      if (find) {
        const found = passagesFor(text, find);
        return {
          content: [
            {
              type: 'text',
              text: found.length
                ? `${head}\n\n${found.length} passage(s) containing "${find}":\n\n${found
                    .map((p) => `[offset ${p.at}] … ${p.text} …`)
                    .join('\n\n')}`
                : `${head}\n\nNo passages containing "${find}".`,
            },
          ],
        };
      }

      const end = Math.min(text.length, offset + length);
      return {
        content: [
          {
            type: 'text',
            text: `${head}\nshowing ${offset}-${end}${
              end < text.length ? ` | next_offset: ${end}` : ' | end of document'
            }\n\n${text.slice(offset, end)}`,
          },
        ],
      };
    },
  );

  registerAppResource(server, 'SMPTE Search UI', resourceUri, {}, async () => ({
    contents: [
      {
        uri: resourceUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await Bun.file('dist/mcp-app.html').text(),
      },
    ],
  }));

  server.registerResource(
    'SMPTE Documentation',
    new ResourceTemplate(documentUri, {
      list: async () => ({
        resources: [...docs].map(([slug, title]) => ({
          uri: `smpte://doc/${encodeURIComponent(slug)}`,
          name: title,
          title,
          description: `Complete SMPTE documentation for ${title}`,
          mimeType: 'text/plain',
        })),
      }),
    }),
    {
      title: 'SMPTE Documentation',
      description: 'Full extracted text of an SMPTE document, addressed by slug.',
      mimeType: 'text/plain',
    },
    async (uri, { slug }) => {
      const resolved = resolveSlug(String(slug));
      const text = resolved ? readText(resolved) : null;
      if (text === null) throw new Error(`SMPTE document not found: ${slug}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
    },
  );

  return server;
});

export const mcp = {
  fetch: async (req: Request) => {
    const started = performance.now();
    const path = new URL(req.url).pathname;

    if (!authorized(req)) {
      logger.warning('MCP request rejected: invalid bearer token', {
        method: req.method,
        path,
      });

      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        },
      });
    }

    try {
      const response = await handler.fetch(req);
      logger.trace('MCP request completed', {
        method: req.method,
        path,
        status: response.status,
        ms: +(performance.now() - started).toFixed(2),
      });
      return response;
    } catch (error) {
      logger.error('MCP request failed', { method: req.method, path, error });
      throw error;
    }
  },
};

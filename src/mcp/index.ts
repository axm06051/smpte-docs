// MCP server slice: the search_smpte and read_smpte_document tools, the in-chat search UI and the
// smpte://doc resources, behind an optional bearer token.
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { docs } from '../catalog';
import { BASE } from '../catalog/doc';
import { logger, since } from '../platform/logger';
import { esc, pl } from '../platform/text';
import { baseOf, passagesFor, readText, resolveSlug, titleOf } from './documents';
import { searchDocs } from './search';

const MCP_TOKEN = process.env.MCP_TOKEN || '';

const resourceUri = 'ui://smpte-search/search.html';
const documentUri = 'smpte://doc/{slug}';

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
          ms: since(started),
        });

        const html = `<form data-tool="search_smpte">
  <input name="q" value="${esc(q)}" aria-label="Search SMPTE documentation" autofocus>
  <button type="submit">Search</button>
</form>
<p>${results.length} result${pl(results.length)} for <b>${esc(q)}</b></p>
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
        resources: docs.map(({ slug, title }) => ({
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
        ms: since(started),
      });
      return response;
    } catch (error) {
      logger.error('MCP request failed', { method: req.method, path, error });
      throw error;
    }
  },
};

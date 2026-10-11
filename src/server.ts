import { docs, pdfUrls, roots, versions } from './catalog';
import { mcp } from './mcp';
import { detailRoute } from './library/detail';
import { pageRoute } from './library/page';
import { searchIndex, searchRoute } from './library/search';
import { versionsRoute } from './library/versions';
import { DB_PATH } from './platform/db';
import { notFound, PROD } from './platform/http';
import { logger, since } from './platform/logger';
import { NOISE_CONFIG } from './platform/toc';

const HOST = process.env.HOST ?? 'localhost';
const PORT = Number(process.env.PORT ?? 3000);

logger.info('snippet noise filter configured', NOISE_CONFIG);
logger.info('server initialized', {
  docs: docs.length,
  roots: roots.length,
  indexedTerms: searchIndex.size,
  database: DB_PATH,
  versions: Object.keys(versions).length,
  pdfUrls: Object.keys(pdfUrls).length,
  port: PORT,
  environment: process.env.NODE_ENV ?? 'development',
});

Bun.serve({
  port: PORT,

  async fetch(req) {
    const started = performance.now();
    const u = new URL(req.url);
    const path = u.pathname;

    logger.trace('HTTP request started', {
      method: req.method,
      path,
      queryPresent: u.search.length > 0,
    });

    try {
      const response = await handleRequest(req, u);
      const ms = since(started);

      const context = {
        method: req.method,
        path,
        status: response.status,
        ms,
      };

      if (response.status >= 500) {
        logger.error('HTTP request completed with server error', context);
      } else if (response.status >= 400) {
        logger.warning('HTTP request completed with client error', context);
      } else {
        logger.info('HTTP request completed', context);
      }

      return response;
    } catch (error) {
      logger.error('HTTP request failed with exception', {
        method: req.method,
        path,
        ms: since(started),
        error,
      });

      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
});

logger.info('HTTP server listening', {
  host: HOST,
  port: PORT,
  url: `http://${HOST}:${PORT}`,
  production: PROD,
});

async function handleRequest(req: Request, u: URL): Promise<Response> {
  if (u.pathname === '/healthz') return new Response('ok');
  if (u.pathname === '/mcp') return mcp.fetch(req);
  if (u.pathname.startsWith('/detail/')) return detailRoute(req, u);
  if (u.pathname === '/search') return searchRoute(req, u);
  if (u.pathname.startsWith('/versions/')) return versionsRoute(req, u);
  return (await pageRoute(req, u)) ?? notFound();
}

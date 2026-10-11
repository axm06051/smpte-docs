// The read-only full-text index, opened once for both the web UI (server.ts) and the MCP tools (mcp.ts).
import { Database } from 'bun:sqlite';
import { logger } from './logger';

export const DB_PATH = '.data/searchindex.sqlite';
export const db = (() => {
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

// The index holds one row per document ("st2110-21") and one per published edition
// ("st2110-21_st2110-21-2017"). slug is UNINDEXED, so WHERE slug = ? scans (~18 ms); resolve
// slug -> rowid once and use rowid lookups (~0.1-0.4 ms) everywhere.
export const rowIds = new Map(
  (db.query('SELECT rowid AS id, slug FROM docs').all() as { id: number; slug: string }[]).map(
    (r) => [r.slug, r.id],
  ),
);

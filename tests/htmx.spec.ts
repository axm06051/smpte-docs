import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const html = readFileSync('src/index.html', 'utf8');
const server = readFileSync('src/server.ts', 'utf8');
const app = readFileSync('src/app.ts', 'utf8');

test('responsive search keeps the normal query path local', () => {
  expect(html).not.toContain('hx-get="/search"');
  expect(app).toContain('localSearch');
  expect(app).toContain('requestAnimationFrame');
  expect(app).toContain('requestFullSearch');
  expect(app).toMatch(
    /function localSearch\(\) \{[\s\S]*?detailController\?\.abort\(\);[\s\S]*?if \(full\.checked\)/,
  );
});

test('lazy version loading is delegated, prepared-response backed, and swapped by htmx', () => {
  // No per-row hx-* attributes: htmx does not observe the DOM, so innerHTML-rendered rows would
  // never be wired. One capture-phase toggle listener covers every row however it was rendered.
  // The list is fetched through fragment() (shared with hover/pointer-down prefetching, so a click
  // joins an in-flight request instead of repeating it) and htmx.swap performs the DOM update.
  expect(server).not.toContain('hx-get');
  expect(app).not.toContain('hx-get');
  expect(app).toContain("'toggle'");
  expect(app).toContain('const url = `/versions/${encodeURIComponent(slug)}`');
  expect(app).toContain('bulkFragment(url) : fragment(url)');
  expect(app).toContain('htmx.swap(target, html');
  expect(server).toContain("u.pathname.startsWith('/versions/')");
});

test('autocomplete preview is rendered locally from the page data', () => {
  expect(app).toContain('function previewHtml(d: SearchDoc)');
  expect(app).toContain("acList.addEventListener('mouseover'");
  expect(app).toContain("acList.addEventListener('focusin'");
  expect(server).not.toContain('/autocomplete');
});

test('autocomplete preserves the result limit and empty-query behavior', () => {
  expect(app).toContain('.slice(0, 8)');
  expect(app).toContain('No suggestions');
  expect(app).toContain('showPreview(undefined)');
});

test('HTMX PDF text search preserves master snippets in matching rows', () => {
  expect(server).toContain('SELECT slug, text FROM docs WHERE docs MATCH ?');
  expect(server).not.toContain('snippet(docs');
  expect(server).not.toContain('bm25(docs)');
  expect(server).toContain('bodyMatch(r.slug, r.text, rx)');
  expect(server).toContain('<div class=\"sn\">');
  expect(server).toContain('highlight(');
  expect(server).toContain("u.searchParams.get('full') === '1'");
});

test('HTMX restores the master detail pane through a server fragment', () => {
  expect(html).toContain('id="detail"');
  expect(server).toContain("u.pathname.startsWith('/detail/')");
  expect(server).toContain('autocompletePreview');
  expect(server).toContain('highlightSnippet');
});

test('HTMX tree rows retain stable selection and keyboard navigation hooks', () => {
  expect(server).toContain('data-slug="${esc(d.slug)}"');
  expect(server).toContain('data-preview="/detail/${esc(d.slug)}"');
  expect(app).toContain('function loadDetail(row: HTMLElement)');
  expect(server).toContain('tabindex="-1"');
  expect(app).toContain("case 'ArrowDown'");
  expect(app).toContain("case 'ArrowUp'");
  expect(app).toContain("case 'PageDown'");
  expect(app).toContain("case 'PageUp'");
  expect(app).toContain("case 'Home'");
  expect(app).toContain("case 'End'");
});

test('HTMX migration preserves URL search state and search shortcuts', () => {
  expect(app).toContain('URLSearchParams');
  expect(app).toContain('history.replaceState');
  expect(app).toContain('location.hash');
  expect(app).toContain("event.key.toLowerCase() === 'k'");
  expect(app).toContain("event.key === '/'");
});

test('full-text tree search reuses the snippet hit set instead of querying twice', () => {
  expect(server).toContain(
    'const snippets = full && q ? fullSnippets(q, cat, re) : new Map<string, string>();',
  );
  expect(server).toContain('new Set(snippets.keys())');
  expect(server).toContain('fullMatchSlugs?: Set<string>');
  expect(server).toContain('fullMatchSlugs || new Set(fullSnippets(q, cat, re).keys())');
});

test('tree preview and theme colors survive local rendering', () => {
  const app = readFileSync('src/app.ts', 'utf8');
  const css = readFileSync('src/style.css', 'utf8');

  expect(app).toContain('data-preview="/detail/${esc(d.slug)}"');
  expect(app).toContain("details.dataset.hydrated !== '1'");
  expect(app).toContain('renderChildren(children, parent)');
  expect(css).toContain('--selected:');
  expect(css).toContain('--highlight:');
  expect(css).toContain('background: var(--control-bg)');
});

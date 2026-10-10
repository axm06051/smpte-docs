import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('responsive search keeps typing local and keeps the preview shell', () => {
  const html = readFileSync('src/index.html', 'utf8');
  const app = readFileSync('src/app.ts', 'utf8');

  expect(html).not.toContain('hx-get="/search"');
  expect(html).not.toContain('hx-trigger="input changed delay:75ms"');
  expect(app).toContain('requestAnimationFrame');
  expect(app).toContain('renderAutocomplete');
  expect(app).toContain('localSearch');
});

test('autocomplete and its preview both render locally', () => {
  const html = readFileSync('src/index.html', 'utf8');
  const app = readFileSync('src/app.ts', 'utf8');

  expect(html).toContain('class="ac"');
  expect(html).toContain('id="acList"');
  expect(html).toContain('id="acPrev"');
  expect(app).toContain('previewHtml');
});

test('responsive PDF search cancels stale requests and stale detail previews', () => {
  const app = readFileSync('src/app.ts', 'utf8');

  expect(app).toContain('AbortController');
  expect(app).toContain('fullController?.abort()');
  expect(app).toContain('detailController?.abort()');
  expect(app).toContain('if (controller.signal.aborted) return');
});

test('theme is applied before the stylesheet can paint', () => {
  const html = readFileSync('src/index.html', 'utf8');
  const theme = html.indexOf(
    "document.documentElement.dataset.theme = localStorage.getItem('smpte-theme') || 'system'",
  );
  const css = html.indexOf('<link rel="stylesheet" href="/style.css" />');
  expect(theme).toBeGreaterThan(-1);
  expect(theme).toBeLessThan(css);
});

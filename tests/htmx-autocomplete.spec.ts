import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('autocomplete keeps the accessible listbox and preview shell', () => {
  const html = readFileSync('src/index.html', 'utf8');
  const app = readFileSync('src/app.ts', 'utf8');

  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-controls="acList"');
  expect(html).toContain('id="acList"');
  expect(html).toContain('id="acPrev"');
  expect(app).toContain('renderAutocomplete');
  expect(app).toContain('role="option"');
});

test('autocomplete preview is local and the server no longer serves dead autocomplete routes', () => {
  const server = readFileSync('src/server.ts', 'utf8');
  const app = readFileSync('src/app.ts', 'utf8');

  expect(app).toContain('class="ac-item"');
  expect(app).toContain('role="option"');
  expect(app).toContain('acPrev.innerHTML');
  expect(server).not.toContain("u.pathname === '/autocomplete'");
  expect(server).not.toContain('<option value="${esc(d.designator)}">');
});

test('autocomplete keeps the accessible shell contract', () => {
  const html = readFileSync('src/index.html', 'utf8');
  const css = readFileSync('src/style.css', 'utf8');

  expect(html).toMatch(/<div class="ac" id="ac"(?:\s[^>]*)?>/);
  expect(html).toContain(
    '<ul class="ac-list" id="acList" role="listbox" aria-label="Suggestions"></ul>',
  );
  expect(html).toContain('<div class="ac-preview" id="acPrev"></div>');
  expect(css).toContain('.ac.open');
});

test('autocomplete uses local filtering and preserves highlighting', () => {
  const app = readFileSync('src/app.ts', 'utf8');

  expect(app).toContain('docs.filter');
  expect(app).toContain('.slice(0, 8)');
  expect(app).toContain('aria-selected');
  expect(app).toContain('highlight(d.designator, words)');
  expect(app).toContain('highlight(d.name, words)');
});

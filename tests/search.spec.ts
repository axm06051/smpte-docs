import { expect, test, type Page } from '@playwright/test';

const search = (page: Page) => page.getByRole('combobox', { name: /search/i });

const edgeCases = [
  '',
  '   ',
  '<script>alert(1)</script>',
  '"quotes" \'apostrophes\'',
  'SMPTE éß — 日本語',
  'a'.repeat(4096),
];

test.describe('search edge cases', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  for (const value of edgeCases) {
    test(`handles ${JSON.stringify(value).slice(0, 80)}`, async ({ page }) => {
      const input = search(page);
      await input.fill(value);
      await expect(page.getByRole('tree', { name: 'SMPTE documents' })).toBeVisible();
      expect(await page.locator('body').innerHTML()).not.toContain('<script>alert(1)</script>');
    });
  }

  test('handles an invalid regular expression without a server error', async ({ page }) => {
    await page.getByLabel('Regex').check();
    await search(page).fill('[');
    await expect(page.getByRole('tree', { name: 'SMPTE documents' })).toBeVisible();
    await expect(page.getByText(/500|internal server error/i)).toHaveCount(0);
  });
});

test('search remains responsive under repeated input', async ({ page }) => {
  await page.goto('/');
  const input = search(page);
  const queries = ['st 2110', 'mxf', 'color', 'metadata', 'timecode', 'standard', 'audio', 'video'];
  const durations: number[] = [];
  const requests: string[] = [];

  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/search') requests.push(request.url());
  });

  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('Search input not found');

    input.addEventListener(
      'input',
      () => {
        performance.mark('search-input-start');
      },
      { capture: true },
    );

    input.addEventListener('input', () => {
      performance.mark('search-input-end');
      const measure = performance.measure('search-input', 'search-input-start', 'search-input-end');
      (input as HTMLInputElement).dataset.searchDuration = String(measure.duration);
    });
  });

  for (const value of queries) {
    await input.fill(value);

    const duration = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="search"]');
      return Number(input?.dataset.searchDuration);
    });

    durations.push(duration);

    await expect(page.getByRole('tree', { name: 'SMPTE documents' })).toBeVisible();
    await expect(page.locator('#meta')).toContainText('matching documents');
  }

  durations.sort((a, b) => a - b);
  const p95 = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)];

  expect(p95, `local search handler p95: ${p95.toFixed(1)}ms`).toBeLessThan(100);
  expect(requests).toHaveLength(0);
});

test('search endpoint sustains concurrent load', async ({ page }) => {
  await page.goto('/');
  const queries = Array.from({ length: 20 }, (_, i) => `st 2110 ${i}`);
  const started = performance.now();
  const responses = await Promise.all(
    queries.map((query) => page.request.get(`/search?q=${encodeURIComponent(query)}`)),
  );
  const elapsed = performance.now() - started;

  expect(responses.every((response) => response.ok())).toBe(true);
  expect(elapsed).toBeLessThan(5000);
});

test('normal search does not accumulate stale requests', async ({ page }) => {
  await page.goto('/');
  const input = search(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/search') requests.push(request.url());
  });

  for (let i = 0; i < 20; i++) await input.fill(`st 2110 ${i}`);
  await expect(page.getByRole('tree', { name: 'SMPTE documents' })).toBeVisible();

  expect(requests).toHaveLength(0);
  await expect(page.locator('#meta')).toContainText('matching documents');
});

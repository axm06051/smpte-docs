import { expect, test, type Page } from '@playwright/test';

// Browser behaviour: first paint, intent prefetching, prepared-response reuse, and navigation
// correctness (stale clicks, failures, history, deep links).
const FRAGMENT = /^\/(?:detail|versions)\//;

function track(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (FRAGMENT.test(u.pathname)) urls.push(u.pathname + u.search);
  });
  return urls;
}
// app.js has run (and replaced the server-rendered first screenful with the full tree) once the
// stats hook exists.
const ready = async (page: Page) => {
  await page.goto('/');
  await page.waitForFunction(() => '__fragmentStats' in window);
};
const stats = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __fragmentStats: Record<string, number> }).__fragmentStats,
  );
const leaf = (page: Page) => page.locator('#results > .row:not(.suite):has(.cnt)').first();
const slugOf = (row: ReturnType<typeof leaf>) => row.getAttribute('data-slug');

test('first paint does not need JavaScript', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/');
  expect(await page.locator('#results > .row').count()).toBeGreaterThanOrEqual(20);
  await expect(page.locator('#results > .row .slug').first()).not.toBeEmpty();
  await expect(page.locator('#meta')).toContainText('documents');
  await ctx.close();
});

test('server-rendered rows are identical to what the client renders (nothing shifts)', async ({
  browser,
  page,
}) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const nojs = await ctx.newPage();
  await nojs.goto('/');
  const server = (await nojs.locator('#results').innerHTML()).trim();
  const n = await nojs.locator('#results > .row').count();
  await ctx.close();

  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await ready(page);
  await page.waitForTimeout(400);
  const client = await page.evaluate(
    (count) =>
      [...document.querySelectorAll('#results > li')]
        .slice(0, count)
        .map((e) => e.outerHTML)
        .join(''),
    n,
  );
  expect(client).toBe(server);
  expect(await page.locator('#results > .row').count()).toBeGreaterThan(n); // full tree is there
  expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(
    0.01,
  );
});

test('hover intent prepares the fragments; the click reuses them (no second request)', async ({
  page,
}) => {
  const urls = track(page);
  await ready(page);
  const row = leaf(page);
  const slug = await slugOf(row);
  await row.locator('summary > .slug').hover();
  await expect.poll(() => urls.length).toBe(2); // detail + versions, before any click
  expect(urls.sort()).toEqual([`/detail/${slug}`, `/versions/${slug}`]);
  await row.locator('summary > .slug').click();
  await expect(page.locator('#detail .pv-title')).toBeVisible();
  await expect(row.locator('.versions li').first()).toBeVisible();
  await page.waitForTimeout(150);
  expect(urls).toHaveLength(2);
  const s = await stats(page);
  expect(s.hits).toBeGreaterThanOrEqual(2);
  expect(s.misses).toBe(0);
});

test('a brief pass over a row is not intent', async ({ page }) => {
  const urls = track(page);
  await ready(page);
  // Dispatched in-page so the dwell is exactly 10 ms (two CDP round trips can exceed the 65 ms delay).
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const results = document.getElementById('results')!;
        results
          .querySelector('.row .slug')!
          .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
        setTimeout(() => {
          results.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
          done();
        }, 10);
      }),
  );
  await page.waitForTimeout(250);
  expect(urls).toEqual([]);
});

test('clicking right after pointer-down joins the in-flight request instead of repeating it', async ({
  page,
}) => {
  const urls = track(page);
  await page.route('**/detail/**', async (route) => {
    await new Promise((r) => setTimeout(r, 250));
    await route.continue();
  });
  await ready(page);
  const row = leaf(page);
  const slug = await slugOf(row);
  await row.locator('summary > .slug').click(); // no hover dwell: pointer-down is the only intent
  await expect(page.locator('#detail .pv-title')).toBeVisible();
  expect(urls.filter((u) => u === `/detail/${slug}`)).toHaveLength(1);
  expect((await stats(page)).joined).toBeGreaterThanOrEqual(1);
});

test('speculative concurrency is capped', async ({ page }) => {
  let inflight = 0;
  let max = 0;
  page.on('request', (r) => {
    if (!FRAGMENT.test(new URL(r.url()).pathname)) return;
    max = Math.max(max, ++inflight);
  });
  const done = () => {
    inflight = Math.max(0, inflight - 1);
  };
  page.on('requestfinished', (r) => FRAGMENT.test(new URL(r.url()).pathname) && done());
  page.on('requestfailed', (r) => FRAGMENT.test(new URL(r.url()).pathname) && done());
  await page.route('**/detail/**', async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await ready(page);
  const rows = page.locator('#results > .row > details > summary > .slug');
  for (let i = 0; i < 12; i++) {
    await rows.nth(i).hover();
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(1200);
  expect(max).toBeGreaterThan(0);
  expect(max).toBeLessThanOrEqual(2);
  const s = await stats(page);
  expect(s.entries).toBeLessThanOrEqual(64);
});

test('data-saver disables speculation but explicit navigation still works', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true, effectiveType: '4g' },
      configurable: true,
    }),
  );
  const urls = track(page);
  await ready(page);
  const row = leaf(page);
  await row.locator('summary > .slug').hover();
  await page.waitForTimeout(300);
  expect(urls).toEqual([]);
  await row.locator('summary > .slug').click();
  await expect(page.locator('#detail .pv-title')).toBeVisible();
});

test('speculation never leaves the two read-only fragment routes and only uses GET', async ({
  page,
}) => {
  const seen: { method: string; path: string }[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (
      u.origin === new URL(page.url()).origin &&
      !u.pathname.startsWith('/assets/') &&
      u.pathname !== '/'
    )
      seen.push({ method: r.method(), path: u.pathname });
  });
  await ready(page);
  const rows = page.locator('#results > .row > details > summary > .slug');
  for (let i = 0; i < 6; i++) {
    await rows.nth(i).hover();
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(300);
  expect(seen.length).toBeGreaterThan(0);
  for (const r of seen) {
    expect(r.method).toBe('GET');
    expect(r.path).toMatch(FRAGMENT);
  }
});

test('a failed fetch shows feedback and is never cached; the next attempt succeeds', async ({
  page,
}) => {
  await ready(page);
  await page.route('**/detail/**', (route) => route.abort());
  const row = leaf(page);
  await row.locator('summary > .slug').click();
  await expect(page.locator('#detail')).toContainText('Preview unavailable');
  await page.unroute('**/detail/**');
  await row.locator('summary > .slug').click();
  await expect(page.locator('#detail .pv-title')).toBeVisible();
});

test('a failed version list can be retried by collapsing and expanding', async ({ page }) => {
  await ready(page);
  await page.route('**/versions/**', (route) => route.abort());
  const row = leaf(page);
  const summary = row.locator('summary > .slug');
  await summary.click();
  await expect(row.locator('.versions')).toContainText('Versions unavailable');
  await page.unroute('**/versions/**');
  await summary.click(); // collapse
  await summary.click(); // expand: retries
  await expect(row.locator('.versions li').first()).toBeVisible();
});

test('prepared responses expire instead of showing stale content', async ({ page }) => {
  await page.clock.install();
  const urls = track(page);
  await ready(page);
  const row = leaf(page);
  const slug = await slugOf(row);
  await row.locator('summary > .slug').hover();
  await page.clock.fastForward(200);
  await expect.poll(() => urls.filter((u) => u === `/detail/${slug}`).length).toBe(1);
  await page.clock.fastForward('06:00'); // past the 5 minute lifetime
  await row.locator('summary > .slug').click();
  await expect(page.locator('#detail .pv-title')).toBeVisible();
  await expect.poll(() => urls.filter((u) => u === `/detail/${slug}`).length).toBe(2);
});

test('the pane always shows the row you selected last, even if an earlier answer arrives later', async ({
  page,
}) => {
  await ready(page);
  const rows = page.locator('#results > .row > details > summary > .slug');
  const first = page.locator('#results > .row').nth(0);
  const second = page.locator('#results > .row').nth(1);
  const firstSlug = await first.getAttribute('data-slug');
  const secondDes = (await second.locator('.slug').first().textContent())!.trim();
  await page.route(`**/detail/${firstSlug}`, async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  await rows.nth(0).click({ noWaitAfter: true });
  await rows.nth(1).click();
  await expect(page.locator('#detail')).toContainText(secondDes);
  await page.waitForTimeout(700); // the slow first answer has now arrived
  await expect(page.locator('#detail')).toContainText(secondDes);
});

test('detail requests keep one cacheable URL unless PDF-text search needs the query', async ({
  page,
  request,
}) => {
  // Needs PDF text in .data/searchindex.sqlite (rebuilt locally by `bun run index`).
  const probe = await (await request.get('/search?q=color&full=1')).text();
  test.skip(!probe.includes('class="sn"'), 'search index contains no PDF text');
  const urls = track(page);
  await ready(page);
  await page.fill('#q', 'color');
  await page.locator('#q').blur();
  await expect(page.locator('#ac')).not.toHaveClass(/open/);
  await page.locator('#results > .row > details > summary > .slug').first().click();
  await expect(page.locator('#detail .pv-title')).toBeVisible();
  expect(urls.find((u) => u.startsWith('/detail/'))).not.toContain('?');
  await page.check('#full');
  await expect(page.locator('#results .sn').first()).toBeVisible();
  await page.locator('#results .row:has(.sn) .slug').first().click();
  await expect.poll(() => urls.some((u) => /\/detail\/.*\?q=color.*full=1/.test(u))).toBe(true);
});

test('keyboard navigation moves the pane and prepares the neighbours', async ({ page }) => {
  const urls = track(page);
  await ready(page);
  const rows = page.locator('#results > .row');
  const slug = (i: number) => rows.nth(i).getAttribute('data-slug');
  await rows.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await expect(page.locator('#detail .pv-title')).toBeVisible();
  await expect.poll(() => urls.length).toBeGreaterThan(1);
  expect(urls).toContain(`/detail/${await slug(1)}`);
  expect(urls).toContain(`/detail/${await slug(2)}`); // next neighbour, prepared before it is needed
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(2)).toBeFocused();
  await page.waitForTimeout(150);
  const third = await slug(2);
  expect(urls.filter((u) => u === `/detail/${third}`)).toHaveLength(1);
});

test('selecting rows does not add history entries; back/forward and refresh keep the page working', async ({
  page,
}) => {
  await ready(page);
  const before = await page.evaluate(() => history.length);
  await page.locator('#results > .row > details > summary > .slug').nth(2).click();
  await expect(page.locator('#detail .pv-title')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(before);
  await page.goto('about:blank');
  await page.goBack();
  await expect(page.locator('#results > .row').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('#results > .row').first()).toBeVisible();
});

test('deep links with search state in the hash load the page and keep their state in the URL', async ({
  page,
}) => {
  await page.goto('/#q=2110&cat=ST');
  await page.waitForFunction(() => '__fragmentStats' in window);
  await expect(page.locator('#results > .row').first()).toBeVisible();
  await page.fill('#q', 'mxf');
  await expect.poll(() => page.url()).toContain('q=');
});

test('a repeat visit loads hashed assets from cache and only revalidates the HTML', async ({
  page,
}) => {
  await ready(page);
  const cold = await page.evaluate(
    () =>
      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).transferSize,
  );
  await ready(page); // second navigation, same HTTP cache
  const warm = await page.evaluate(
    () =>
      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).transferSize,
  );
  expect(cold).toBeGreaterThan(20_000); // the whole document
  expect(warm).toBeLessThan(2_000); // a 304: headers only
  const assets = await page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((e) => e.name.includes('/assets/'))
      .map((e) => e.transferSize),
  );
  expect(assets).toEqual([0, 0]); // served from the HTTP cache: nothing crossed the network
});

test('typing in search stays local (no requests)', async ({ page }) => {
  const urls: string[] = [];
  await ready(page);
  page.on('request', (r) => urls.push(new URL(r.url()).pathname));
  await page.fill('#q', 'st 2110');
  await page.waitForTimeout(300);
  expect(urls).toEqual([]);
  await expect(page.locator('#meta')).toContainText('matching documents');
});

test('"Expand all" loads every version list, in a bounded low-priority lane', async ({ page }) => {
  let inflight = 0;
  let max = 0;
  const isV = (r: import('@playwright/test').Request) =>
    new URL(r.url()).pathname.startsWith('/versions/');
  page.on('request', (r) => isV(r) && (max = Math.max(max, ++inflight)));
  page.on('requestfinished', (r) => isV(r) && inflight--);
  page.on('requestfailed', (r) => isV(r) && inflight--);
  await page.route('**/versions/**', async (route) => {
    await new Promise((r) => setTimeout(r, 20));
    await route.continue();
  });
  await ready(page);
  await page.click('#expBtn');
  const leaves = await page.locator('#results > .row:not(.suite) > details').count();
  await expect
    .poll(() => page.locator('#results > .row:not(.suite) > details[data-loaded]').count(), {
      timeout: 20_000,
    })
    .toBe(leaves);
  await expect(page.locator('#results .versions', { hasText: 'unavailable' })).toHaveCount(0);
  expect(max).toBeLessThanOrEqual(4);
  expect(
    await page.locator('#results > .row:not(.suite):has(.cnt) .versions li').count(),
  ).toBeGreaterThan(0);
});

test('"Expand all" opens every level and records all of them in the URL hash', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'st 2110');
  await page.locator('#q').blur();
  await page.click('#expBtn');
  await expect(page.locator('#results details:not([open])')).toHaveCount(0);
  const levels = await page.evaluate(() =>
    Math.max(
      ...[...document.querySelectorAll('#results .row')].map((r) =>
        Number(r.getAttribute('aria-level')),
      ),
    ),
  );
  expect(levels).toBeGreaterThanOrEqual(2);
  const open = await page.evaluate(() =>
    new URLSearchParams(location.hash.slice(1)).get('open')!.split('.'),
  );
  const slugs = await page.evaluate(() =>
    [...document.querySelectorAll('#results details')].map(
      (d) => d.closest<HTMLElement>('.row')!.dataset.slug!,
    ),
  );
  expect(new Set(open)).toEqual(new Set(slugs)); // every open row, at every depth, is in the hash
});

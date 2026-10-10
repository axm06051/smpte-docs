// Reproducible performance benchmark.  Usage: bun scripts/perf-bench.ts [out.json] [--runs=N]
// Needs the server running (BASE_URL, default http://127.0.0.1:3000) and Playwright's Chromium.
// Profiles use CDP network emulation; numbers are medians (p75 in brackets) over N runs.
import { chromium, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const ORIGIN = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const BASE = ORIGIN; // upstream server
const LOADS = Number(process.argv.find((a) => a.startsWith('--loads='))?.slice(8) ?? 15);
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 9);
const OUT = process.argv.find((a) => !a.startsWith('-') && a.endsWith('.json'));
const PROFILES: Record<string, { latency: number; down: number }> = {
  lan: { latency: 0, down: -1 },
  broadband: { latency: 40, down: (10 * 1024 * 1024) / 8 }, // 40 ms RTT, 10 Mbit/s
  slow4g: { latency: 150, down: (1.6 * 1024 * 1024) / 8 }, // Lighthouse "slow 4G"
};

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const summary = (xs: number[]) => ({
  median: +q(xs, 0.5).toFixed(1),
  p75: +q(xs, 0.75).toFixed(1),
});

const INIT = `
  window.__lcp = 0; window.__cls = 0; window.__rowsAt = 0; window.__lat = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
    .observe({ type: 'layout-shift', buffered: true });
  addEventListener('DOMContentLoaded', () => {
    const r = document.getElementById('results');
    const check = () => { if (!window.__rowsAt && r.querySelector('.row')) window.__rowsAt = performance.now(); };
    check(); new MutationObserver(check).observe(r, { childList: true });
  });
  // click -> visible-content latency for the detail pane and version lists
  let t0 = 0; const pending = {};
  addEventListener('click', (e) => { t0 = e.timeStamp; pending.detail = pending.versions = true; }, true);
  addEventListener('DOMContentLoaded', () => {
    const done = (kind) => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (t0 && pending[kind]) { pending[kind] = false; window.__lat.push([kind, performance.now() - t0]); }
    }));
    new MutationObserver(() => done('detail')).observe(document.getElementById('detail'), { childList: true });
    new MutationObserver((m) => { if (m.some((x) => x.target.classList?.contains('versions') && x.addedNodes.length)) done('versions'); })
      .observe(document.getElementById('results'), { childList: true, subtree: true });
  });
`;

// Deterministic network shaping: a tiny proxy delays every response by RTT + size/bandwidth.
// (CDP emulation was not reliable for same-origin loopback requests.) Per-request shaping, not a
// shared link, so it is an approximation; it is applied identically before and after a change.
function shapedProxy(port: number, p: { latency: number; down: number }) {
  return Bun.serve({
    port,
    async fetch(req) {
      const u = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.delete('host');
      const up = await fetch(BASE + u.pathname + u.search, {
        method: req.method,
        headers,
        redirect: 'manual',
        decompress: false,
      } as RequestInit);
      const body = new Uint8Array(await up.arrayBuffer());
      const wait = p.latency + (p.down > 0 ? (body.length / p.down) * 1000 : 0);
      if (wait > 0) await Bun.sleep(wait);
      const out = new Headers(up.headers);
      out.delete('content-length');
      return new Response(up.status === 304 ? null : body, { status: up.status, headers: out });
    },
  });
}

async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  return cdp;
}

async function loadMetrics(page: Page) {
  await page.waitForLoadState('load');
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const all = [nav, ...res];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN;
    const w = window as unknown as Record<string, number>;
    return {
      ttfb: nav.responseStart,
      fcp,
      lcp: w.__lcp,
      cls: w.__cls,
      treeAt: w.__rowsAt,
      bytes: all.reduce((n, e) => n + (e.transferSize || 0), 0),
      requests: all.length,
      cacheHits: all.filter((e) => e.transferSize === 0).length,
    };
  });
}

async function scripting(cdp: Awaited<ReturnType<typeof throttle>>) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(
    metrics.map((x: { name: string; value: number }) => [x.name, x.value]),
  );
  return { scriptMs: m.ScriptDuration * 1000, taskMs: m.TaskDuration * 1000 };
}

const agg = (rows: Record<string, number>[]) =>
  Object.fromEntries(Object.keys(rows[0] ?? {}).map((k) => [k, summary(rows.map((r) => r[k]))]));

async function main() {
  const browser = await chromium.launch();
  const report: Record<string, unknown> = {
    base: BASE,
    runs: RUNS,
    when: new Date().toISOString(),
  };
  let port = 3100;
  const only = process.argv
    .find((a) => a.startsWith('--profiles='))
    ?.slice(11)
    .split(',');
  for (const [name, prof] of Object.entries(PROFILES)) {
    if (only && !only.includes(name)) continue;
    const proxy = prof.latency || prof.down > 0 ? shapedProxy(++port, prof) : null;
    const target = proxy ? `http://127.0.0.1:${port}` : ORIGIN;
    const cold: Record<string, number>[] = [];
    const warm: Record<string, number>[] = [];
    for (let i = 0; i < LOADS; i++) {
      const ctx = await browser.newContext();
      await ctx.addInitScript(INIT);
      const page = await ctx.newPage();
      const cdp = await throttle(page);
      await page.goto(target + '/');
      cold.push({ ...(await loadMetrics(page)), ...(await scripting(cdp)) });
      await page.goto(target + '/'); // warm: HTTP cache populated by the first load
      warm.push(await loadMetrics(page));
      await ctx.close();
    }

    // Interactions on one warmed page per run, different row each sample so nothing is cached.
    const sel: number[] = [];
    const selHover: number[] = [];
    const versions: number[] = [];
    const versionsHover: number[] = [];
    const typed: number[] = [];
    const fullText: number[] = [];
    const fragStats: Record<string, number>[] = [];
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext();
      await ctx.addInitScript(INIT);
      const page = await ctx.newPage();
      await throttle(page);
      await page.goto(target + '/');
      await page.waitForSelector('#results .row');
      await page.evaluate(() => fetch('/healthz').then((r) => r.text())); // warm the connection so samples compare like with like
      await page.waitForTimeout(100);
      const take = async (kind: string) => {
        await page
          .waitForFunction(
            (k) => (window as any).__lat.some((x: [string, number]) => x[0] === k),
            kind,
            { timeout: 8000 },
          )
          .catch(() => {});
        return page.evaluate((k) => {
          const w = window as any;
          const hit = w.__lat.find((x: [string, number]) => x[0] === k);
          w.__lat = [];
          return hit ? hit[1] : NaN;
        }, kind);
      };
      const rowCount = await page.locator('#results > .row').count();
      const a = (i * 2) % rowCount;
      const b = (i * 2 + 1) % rowCount;
      await page.locator('#results > .row > details > summary > .slug').nth(a).click();
      sel.push(await take('detail'));
      await page.locator('#results > .row > details > summary > .slug').nth(b).hover();
      await page.waitForTimeout(250); // pointer dwell: baseline ignores it, prefetching uses it
      await page.evaluate(() => ((window as any).__lat = []));
      await page.locator('#results > .row > details > summary > .slug').nth(b).click();
      selHover.push(await take('detail'));
      // versions: open a root-level document that has versions (click, then hover-dwell + click)
      const leaves = page.locator(
        '#results > .row:not(.suite):has(.cnt) > details > summary > .slug',
      );
      const n = await leaves.count();
      await page.evaluate(() => ((window as any).__lat = []));
      await leaves.nth((i * 7 + 3) % Math.max(1, n)).click();
      versions.push(await take('versions'));
      await leaves.nth((i * 7 + 5) % Math.max(1, n)).hover();
      await page.waitForTimeout(250);
      await page.evaluate(() => ((window as any).__lat = []));
      await leaves.nth((i * 7 + 5) % Math.max(1, n)).click();
      versionsHover.push(await take('versions'));
      const st = await page.evaluate(() => (window as any).__fragmentStats ?? null);
      if (st) fragStats.push(st);
      // search latency (local) and PDF-text search (server)
      await page.fill('#q', '');
      const t = await page.evaluate(async () => {
        const qEl = document.getElementById('q') as HTMLInputElement;
        const meta = document.getElementById('meta')!;
        const t0 = performance.now();
        const p = new Promise<number>((res) => {
          new MutationObserver((_, o) => {
            o.disconnect();
            requestAnimationFrame(() => res(performance.now() - t0));
          }).observe(meta, { childList: true, characterData: true, subtree: true });
        });
        qEl.value = 'st 2110';
        qEl.dispatchEvent(new Event('input', { bubbles: true }));
        return p;
      });
      typed.push(t);
      await page.fill('#q', '');
      await page.check('#full');
      const f = await page.evaluate(
        async (term) => {
          const qEl = document.getElementById('q') as HTMLInputElement;
          const results = document.getElementById('results')!;
          const t0 = performance.now();
          const p = new Promise<number>((res) => {
            const mo = new MutationObserver(() => {
              if (results.querySelector('.sn')) {
                mo.disconnect();
                requestAnimationFrame(() => res(performance.now() - t0));
              }
            });
            mo.observe(results, { childList: true, subtree: true });
            setTimeout(() => res(NaN), 8000);
          });
          qEl.value = term;
          qEl.dispatchEvent(new Event('input', { bubbles: true }));
          return p;
        },
        `color-${i}`
          .replace(/-\d+$/, '')
          .concat(
            ['', ' sdi', ' hdr', ' ancillary', ' timecode', ' audio', ' video', ' mxf', ' frame'][
              i % 9
            ],
          ),
      );
      fullText.push(f);
      await ctx.close();
    }
    proxy?.stop(true);
    report[name] = {
      cold: agg(cold),
      warm: agg(warm),
      select_click_only_ms: summary(sel.filter(Number.isFinite)),
      select_after_150ms_hover_ms: summary(selHover.filter(Number.isFinite)),
      versions_open_ms: summary(versions.filter(Number.isFinite)),
      versions_open_after_hover_ms: summary(versionsHover.filter(Number.isFinite)),
      local_search_ms: summary(typed.filter(Number.isFinite)),
      pdf_text_search_ms: summary(fullText.filter(Number.isFinite)),
      prefetch: fragStats.length
        ? (() => {
            const t = (k: string) => fragStats.reduce((n, x) => n + x[k], 0);
            const explicit = t('hits') + t('joined') + t('misses');
            return {
              explicitRequests: explicit,
              hitRate: +((t('hits') + t('joined')) / Math.max(1, explicit)).toFixed(3),
              speculative: t('prefetched'),
              wastedSpeculative: t('wasted'),
              failed: t('failed'),
            };
          })()
        : null,
    };
  }
  await browser.close();
  const json = JSON.stringify(report, null, 2);
  if (OUT) writeFileSync(OUT, json + '\n');
  console.log(json);
}
await main();

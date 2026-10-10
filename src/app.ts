type SearchDoc = {
  id: number;
  slug: string;
  title: string;
  name: string;
  designator: string;
  cat: string;
  parent: number;
  children: number[];
  versions: number;
};

const docs = JSON.parse(document.getElementById('search-data')!.textContent!) as SearchDoc[];
const byId = new Map(docs.map((d) => [d.id, d]));
const roots = docs.filter((d) => d.parent < 0);
const query = document.getElementById('q') as HTMLInputElement;
const form = query.closest('form') as HTMLFormElement;
const results = document.getElementById('results') as HTMLUListElement;
const category = document.getElementById('cat') as HTMLSelectElement;
const regex = document.getElementById('re') as HTMLInputElement;
const full = document.getElementById('full') as HTMLInputElement;
const meta = document.getElementById('meta') as HTMLElement;
const detail = document.getElementById('detail') as HTMLElement;
const theme = document.getElementById('theme') as HTMLSelectElement;
const ac = document.getElementById('ac') as HTMLElement;
const acList = document.getElementById('acList') as HTMLUListElement;
const acPrev = document.getElementById('acPrev') as HTMLElement;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const pdf = (d: SearchDoc) => `https://pub.smpte.org/doc/${encodeURIComponent(d.slug)}/`;
const norm = (s: string) => s.toLowerCase();
const bySlug = new Map(docs.map((d) => [d.slug, d]));
const BASE = 'https://pub.smpte.org';

// Same markup the server's /detail/<slug> fragment produces, built from data the page already has,
// so hovering a suggestion costs no request.
function previewHtml(d: SearchDoc) {
  const parentOf = (x: SearchDoc) => (x.parent >= 0 ? byId.get(x.parent) : undefined);
  const crumbs: string[] = [];
  for (let p = parentOf(d); p; p = parentOf(p)) crumbs.unshift(p.designator);
  let body = `<div class="pv-top"><span class="cat">${esc(d.cat)}</span><span class="pv-des">${esc(d.designator)}</span></div><div class="pv-title">${esc(d.name)}</div>`;
  if (crumbs.length) body += `<div class="pv-meta">Suite: <b>${esc(crumbs.join(' › '))}</b></div>`;
  const parent = parentOf(d);
  if (parent)
    body += `<div class="pv-meta">Part ${parent.children.indexOf(d.id) + 1} of ${parent.children.length} in ${esc(parent.designator)}</div>`;
  const n = d.children.length;
  if (n) {
    const first = d.children
      .slice(0, 5)
      .map((id) => esc(byId.get(id)!.designator))
      .join(', ');
    body += `<div class="pv-meta"><b>${n}</b> part${n === 1 ? '' : 's'}: ${first}${n > 5 ? ` &hellip; +${n - 5} more` : ''}</div>`;
  }
  if (d.versions)
    body += `<div class="pv-meta"><b>${d.versions}</b> dated version${d.versions === 1 ? '' : 's'}</div>`;
  return `${body}<div class="pv-meta"><a href="${BASE}/doc/${esc(d.slug)}/" target="_blank" rel="noopener">Open document page &#8599;</a></div>`;
}
let shownPreview = '';
function showPreview(slug: string | undefined) {
  if (slug === shownPreview) return;
  shownPreview = slug || '';
  const d = slug ? bySlug.get(slug) : undefined;
  acPrev.innerHTML = d ? previewHtml(d) : '';
}
acList.addEventListener('mouseover', (e) =>
  showPreview((e.target as HTMLElement).closest<HTMLElement>('.ac-item')?.dataset.slug),
);
acList.addEventListener('focusin', (e) =>
  showPreview((e.target as HTMLElement).closest<HTMLElement>('.ac-item')?.dataset.slug),
);
const searchable = docs.map((d) => norm(`${d.designator} ${d.name} ${d.slug}`));

function highlight(text: string, words: string[]) {
  if (!words.length) return esc(text);
  const re = new RegExp(
    `(${words.map((w) => w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')})`,
    'gi',
  );
  let out = '',
    last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    out += esc(text.slice(last, i)) + `<mark>${esc(m[0])}</mark>`;
    last = i + m[0].length;
  }
  return out + esc(text.slice(last));
}

function matches(d: SearchDoc, text: string, words: string[], rx: RegExp | null) {
  if (rx) return rx.test(text);
  return words.every((word) => text.includes(word));
}

function row(d: SearchDoc, level: number, matching: Set<number>) {
  const pad = 12 + level * 22;
  const suite = d.children.length > 0;
  const children = suite
    ? `<ul class="list" role="group" data-children-for="${esc(d.slug)}"></ul>`
    : '';
  const count = d.children.length;
  const version = d.versions
    ? `<span class="cnt">${d.versions} version${d.versions === 1 ? '' : 's'}</span>`
    : '';
  const cat = `<span class="cat${suite ? ' suite' : ''}">${esc(d.cat || (suite ? 'SUITE' : ''))}</span>`;
  const href = suite ? `https://pub.smpte.org/doc/${encodeURIComponent(d.slug)}/` : pdf(d);
  const body = `${cat}<a href="${href}" target="_blank" rel="noopener">${highlight(d.name, wordsForHighlight)}</a>${suite ? `<span class="cnt">${count} part${count === 1 ? '' : 's'}</span>` : version}`;
  return `<li class="row${suite ? ' suite' : ''}" role="treeitem" aria-level="${level + 1}" tabindex="-1" data-slug="${esc(d.slug)}" data-id="${d.id}" data-preview="/detail/${esc(d.slug)}" style="padding-left:${pad}px"><details${suite && autoOpen && hasMatchingChild(d, matching) ? ' open' : ''}><summary><span class="tg-sp"></span><span class="slug">${esc(d.designator)}</span><span class="title">${body}</span></summary>${children}${!suite ? '<ul class="versions"></ul>' : ''}</details></li>`;
}

let wordsForHighlight: string[] = [];
let autoOpen = false;
function hasMatchingChild(d: SearchDoc, matching: Set<number>) {
  return d.children.some((id) => matching.has(id));
}

function renderChildren(list: HTMLUListElement, parent: SearchDoc, matching?: Set<number>) {
  const ids = matching || new Set(parent.children);
  list.innerHTML = parent.children
    .filter((id) => ids.has(id))
    .map((id) =>
      row(
        byId.get(id)!,
        Number(list.closest<HTMLElement>('.row')?.getAttribute('aria-level') || 1),
        ids,
      ),
    )
    .join('');
  list.closest('details')?.setAttribute('data-hydrated', '1');
}

function render(ids: Set<number>, q: string) {
  const visible = new Set(ids);
  for (const id of [...ids])
    for (let d = byId.get(id); d; d = d.parent >= 0 ? byId.get(d.parent) : undefined)
      visible.add(d.id);
  wordsForHighlight = q.trim().split(/\s+/).filter(Boolean);
  autoOpen = Boolean(q || category.value || regex.checked);
  results.innerHTML =
    roots.map((d) => (visible.has(d.id) ? row(d, 0, visible) : '')).join('') ||
    '<li class="empty" role="status">No documents found.</li>';
  meta.textContent =
    q || category.value ? `${ids.size} matching documents` : `${docs.length} documents`;
}

function renderAutocomplete() {
  const q = norm(query.value.trim());
  if (!q) {
    ac.classList.remove('open');
    query.setAttribute('aria-expanded', 'false');
    acList.innerHTML = '';
    showPreview(undefined);
    return;
  }
  const words = q.split(/\s+/).filter(Boolean);
  const matches = docs.filter((d, i) => words.every((w) => searchable[i].includes(w))).slice(0, 8);
  acList.innerHTML = matches.length
    ? matches
        .map(
          (d, i) =>
            `<li class="ac-item" id="ac-i-${i}" role="option" data-slug="${esc(d.slug)}" tabindex="0"><span class="d">${highlight(d.designator, words)}</span><span class="t">${highlight(d.name, words)}</span></li>`,
        )
        .join('')
    : '<li class="ac-none" role="presentation">No suggestions</li>';
  showPreview(undefined);
  showPreview(matches[0]?.slug);
  ac.classList.add('open');
  query.setAttribute('aria-expanded', 'true');
}

function renderLocalSearch() {
  const q = norm(query.value.trim());
  const cat = category.value;
  let rx: RegExp | null = null;
  if (regex.checked && q) {
    try {
      rx = new RegExp(q, 'i');
    } catch {
      render(new Set(), q);
      return;
    }
  }
  const words = rx ? [] : q.split(/\s+/).filter(Boolean);
  const ids = new Set<number>();
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (cat && d.cat !== cat) continue;
    if (!q || matches(d, searchable[i], words, rx)) ids.add(d.id);
  }
  render(ids, q);
}

function localSearch() {
  detailController?.abort();
  detail.innerHTML = '';
  if (full.checked) {
    renderLocalSearch();
    requestFullSearch();
    return;
  }
  fullController?.abort();
  renderLocalSearch();
}

let fullTimer = 0;
let fullController: AbortController | undefined;
let detailController: AbortController | undefined;

function requestFullSearch() {
  clearTimeout(fullTimer);
  fullController?.abort();
  // Empty query: the local render already shows the full tree; don't fetch ~570 KB of it again.
  if (!query.value.trim()) return;
  const controller = (fullController = new AbortController());
  fullTimer = window.setTimeout(async () => {
    const params = new URLSearchParams({
      q: query.value,
      cat: category.value,
      re: regex.checked ? '1' : '',
      full: '1',
    });
    try {
      const response = await fetch(`/search?${params}`, { signal: controller.signal });
      if (!response.ok) return;
      const html = await response.text();
      if (controller.signal.aborted) return;
      results.innerHTML = html;
      meta.textContent = `${results.querySelectorAll('li.row:not(.suite)').length} matching documents`;
    } catch {}
  }, 50);
}

function updateHash() {
  const p = new URLSearchParams();
  if (query.value.trim()) p.set('q', query.value.trim());
  if (category.value) p.set('cat', category.value);
  if (regex.checked) p.set('re', '1');
  const selected = results.querySelector<HTMLElement>('.row.sel');
  if (selected?.dataset.slug) p.set('sel', selected.dataset.slug);
  const open = Array.from(results.querySelectorAll<HTMLDetailsElement>('details[open]'))
    .map((d) => d.closest<HTMLElement>('.row')?.dataset.slug)
    .filter(Boolean);
  if (open.length) p.set('open', open.join('.'));
  history.replaceState(null, '', p.toString() ? `#${p}` : `${location.pathname}${location.search}`);
}

function restoreHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  query.value = p.get('q') || '';
  category.value = /^(ST|RP|EG|RDD|OV)$/.test(p.get('cat') || '') ? p.get('cat')! : '';
  regex.checked = p.get('re') === '1';
  localSearch();
  requestAnimationFrame(() => {
    const selected = rowFor(p.get('sel'));
    if (selected) selectRow(selected);
  });
}

const rows = () => Array.from(results.querySelectorAll<HTMLElement>(':scope > .row'));
const rowFor = (slug: string | null) =>
  slug ? results.querySelector<HTMLElement>(`.row[data-slug="${CSS.escape(slug)}"]`) : null;
function selectRow(row: HTMLElement, focus = false) {
  rows().forEach((el) => {
    const selected = el === row;
    el.classList.toggle('sel', selected);
    el.setAttribute('aria-selected', String(selected));
    el.tabIndex = selected ? 0 : -1;
  });
  if (focus) row.focus({ preventScroll: true });
}

// ---- Intent prefetch + prepared responses ----------------------------------------------------
// Every fragment (row detail, version list) is fetched through fragment().  Explicit requests and
// speculative ones share one table, so a click on something already being fetched joins that request
// instead of issuing a second one, and a prepared response is reused until it expires.  Speculation is
// GET-only, limited to the two read-only fragment routes below, and bounded in every dimension.
const HOVER_MS = 65; // the pointer must rest this long before we treat it as intent
const MAX_ACTIVE = 2; // concurrent speculative fetches
const MAX_QUEUED = 6; // waiting speculative fetches; the oldest intent is dropped first
const MAX_ENTRIES = 64;
const MAX_HELD_BYTES = 256 * 1024; // prepared responses kept in memory
const MAX_SPEC_BYTES = 512 * 1024; // speculative transfer allowed per page view
const TTL = 5 * 60_000; // matches the server's max-age=300 for these fragments
type Entry = {
  p: Promise<string | null>;
  at: number;
  bytes: number;
  ready: boolean;
  spec: boolean;
  used: boolean;
};
const prepared = new Map<string, Entry>(); // insertion order = LRU order
const queue: string[] = [];
const counts = { hits: 0, joined: 0, misses: 0, prefetched: 0, wasted: 0, failed: 0 };
let active = 0;
let held = 0;
let specBytes = 0;

const eligible = (url: string) => /^\/(?:detail|versions)\/[^/?#]+$/.test(url);
const constrained = () => {
  const c = (
    navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  return (
    Boolean(c?.saveData || /(?:^|-)2g$/.test(c?.effectiveType ?? '')) ||
    document.visibilityState === 'hidden'
  );
};
function evict(url: string, e: Entry) {
  if (e.spec && !e.used) counts.wasted++;
  held -= e.bytes;
  prepared.delete(url);
}
function start(url: string, spec: boolean): Entry {
  const e: Entry = {
    p: Promise.resolve(null),
    at: Date.now(),
    bytes: 0,
    ready: false,
    spec,
    used: !spec,
  };
  e.p = fetch(url, {
    credentials: 'same-origin',
    priority: spec ? 'low' : 'high',
  } as RequestInit)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then((text) => {
      e.bytes = text.length;
      e.ready = true;
      held += e.bytes;
      if (spec) specBytes += e.bytes;
      for (const [k, v] of prepared) {
        if (held <= MAX_HELD_BYTES && prepared.size <= MAX_ENTRIES) break;
        if (v.ready && v !== e) evict(k, v);
      }
      return text;
    })
    .catch(() => {
      counts.failed++;
      if (prepared.get(url) === e) prepared.delete(url); // never keep a failed response
      return null;
    })
    .finally(() => {
      if (spec) {
        active--;
        pump();
      }
    });
  prepared.set(url, e);
  return e;
}
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    active++;
    counts.prefetched++;
    start(queue.pop()!, true); // newest intent first
  }
}
// Speculative: deduplicated against queued, in-flight and prepared requests.
function speculate(url: string) {
  if (!eligible(url) || constrained() || specBytes >= MAX_SPEC_BYTES) return;
  const e = prepared.get(url);
  if (e && Date.now() - e.at < TTL) return;
  if (queue.includes(url)) return;
  if (e) evict(url, e);
  queue.push(url);
  while (queue.length > MAX_QUEUED) queue.shift();
  pump();
}
// Explicit: bypasses the queue and the concurrency cap; joins an in-flight or prepared response.
// URLs with a query string (PDF-text snippets) depend on typed input, so they are never shared.
// `bulk` is for loads the user did not individually ask for ("Expand all"): low priority, and not
// kept in the table, so hundreds of them can neither starve a click nor evict useful responses.
const plain = (url: string, priority: 'high' | 'low') =>
  fetch(url, { credentials: 'same-origin', priority } as RequestInit)
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
function fragment(url: string, bulk = false): Promise<string | null> {
  if (url.includes('?')) return plain(url, 'high');
  const e = prepared.get(url);
  if (e && Date.now() - e.at < TTL) {
    e.used = true;
    if (e.ready) counts.hits++;
    else counts.joined++;
    prepared.delete(url);
    prepared.set(url, e); // LRU touch
    return e.p;
  }
  if (e) evict(url, e); // expired: refetch rather than show stale content
  const queued = queue.indexOf(url);
  if (queued >= 0) queue.splice(queued, 1);
  if (bulk) return plain(url, 'low');
  counts.misses++;
  return start(url, false).p;
}
const MAX_BULK = 4; // concurrent bulk loads
let bulkRunning = 0;
const bulkWaiting: (() => void)[] = [];
async function bulkFragment(url: string) {
  if (bulkRunning >= MAX_BULK) await new Promise<void>((resolve) => bulkWaiting.push(resolve));
  bulkRunning++;
  try {
    return await fragment(url, true);
  } finally {
    bulkRunning--;
    bulkWaiting.shift()?.();
  }
}
const bulkOpened = new WeakSet<HTMLDetailsElement>(); // opened by "Expand all", not by the user
// Read-only counters for tests and the benchmark; hit rate = (hits + joined) / all explicit requests.
Object.defineProperty(window, '__fragmentStats', {
  get: () => ({
    ...counts,
    wasted: counts.wasted + [...prepared.values()].filter((e) => e.spec && !e.used).length,
    held,
    specBytes,
    entries: prepared.size,
  }),
});

const UNAVAILABLE =
  '<div class="pv-meta" role="status">Preview unavailable. Select the row again to retry.</div>';
type Htmx = {
  swap: (
    target: Element,
    content: string,
    spec: { swapStyle: string; swapDelay: number; settleDelay: number },
  ) => void;
};
// htmx performs every fragment swap; without it (still loading) the same content is set directly.
function swap(target: Element, html: string) {
  const htmx = (window as Window & { htmx?: Htmx }).htmx;
  if (htmx) htmx.swap(target, html, { swapStyle: 'innerHTML', swapDelay: 0, settleDelay: 0 });
  else target.innerHTML = html;
}

// Only a PDF-text search needs the query server-side (for the snippet).  Every other detail fragment
// is identical for all queries, so it keeps one cacheable URL instead of one per keystroke.
function detailUrl(row: HTMLElement) {
  const path = row.dataset.preview ?? '';
  if (!full.checked || !query.value) return path;
  return `${path}?${new URLSearchParams({ q: query.value, re: regex.checked ? '1' : '0', full: '1' })}`;
}
function intentUrls(row: HTMLElement, versionsToo = true) {
  const d = bySlug.get(row.dataset.slug ?? '');
  if (!d) return [];
  const urls = [detailUrl(row)];
  if (versionsToo && !d.children.length && d.versions)
    urls.push(`/versions/${encodeURIComponent(d.slug)}`);
  return urls;
}
function loadDetail(row: HTMLElement) {
  const path = row.dataset.preview;
  if (!path) return;
  detailController?.abort();
  const controller = (detailController = new AbortController());
  fragment(detailUrl(row)).then((html) => {
    if (controller.signal.aborted) return;
    swap(detail, html ?? UNAVAILABLE);
  });
}

let hoverRow: HTMLElement | null = null;
let hoverTimer = 0;
results.addEventListener('pointerover', (event) => {
  if ((event as PointerEvent).pointerType === 'touch') return;
  const row = (event.target as HTMLElement).closest<HTMLElement>('.row');
  if (row === hoverRow) return;
  clearTimeout(hoverTimer);
  hoverRow = row;
  if (row) hoverTimer = window.setTimeout(() => intentUrls(row).forEach(speculate), HOVER_MS);
});
results.addEventListener('pointerleave', () => {
  clearTimeout(hoverTimer);
  hoverRow = null;
});
results.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('.row');
  if (!row || target.closest('a')) return;
  clearTimeout(hoverTimer); // pointer-down is stronger intent than hover: skip the delay
  intentUrls(row).forEach(speculate);
});
function prefetchNeighbours(row: HTMLElement) {
  const list = rows();
  const i = list.indexOf(row);
  for (const n of [list[i + 1], list[i - 1]]) if (n) intentUrls(n, false).forEach(speculate);
}

results.addEventListener('click', (event) => {
  const summary = (event.target as HTMLElement).closest('summary');
  if (!summary) return;
  requestAnimationFrame(() => {
    const details = summary.parentElement as HTMLDetailsElement;
    if (!details.open || details.dataset.hydrated === '1') return;
    const rowEl = details.closest<HTMLElement>('.row');
    const d = docs.find((x) => x.slug === rowEl?.dataset.slug);
    const list = details.querySelector<HTMLUListElement>(':scope > .list');
    if (d?.children.length && list) renderChildren(list, d);
    updateHash();
  });
});

results.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>('.row');
  if (!row || target.closest('a')) return;
  selectRow(row);
  loadDetail(row);
  updateHash();
});

// Lazy version list.  `toggle` doesn't bubble, so listen in the capture phase; one listener covers
// every row however it was rendered.  The list comes from the prepared-response table (usually
// already fetched by hover intent) and htmx swaps it in.
results.addEventListener(
  'toggle',
  (event) => {
    const details = event.target as HTMLDetailsElement;
    const list = details.querySelector<HTMLUListElement>(':scope > .versions');
    const slug = details.closest<HTMLElement>('.row')?.dataset.slug;
    if (!details.open || !list || !slug || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    const url = `/versions/${encodeURIComponent(slug)}`;
    (bulkOpened.delete(details) ? bulkFragment(url) : fragment(url)).then((html) => {
      if (html !== null) return swap(list, html);
      delete details.dataset.loaded; // collapsing and expanding again retries
      swap(
        list,
        '<li class="empty" role="status">Versions unavailable. Collapse and expand to retry.</li>',
      );
    });
  },
  true,
);

results.addEventListener('keydown', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.row');
  if (!row || event.target !== row) return;
  const list = rows(),
    index = list.indexOf(row);
  let next: HTMLElement | undefined;
  switch (event.key) {
    case 'ArrowDown':
      next = list[Math.min(index + 1, list.length - 1)];
      break;
    case 'ArrowUp':
      if (index === 0) {
        query.focus();
        return;
      }
      next = list[index - 1];
      break;
    case 'PageDown':
      next = list[Math.min(index + 10, list.length - 1)];
      break;
    case 'PageUp':
      next = list[Math.max(index - 10, 0)];
      break;
    case 'Home':
      next = list[0];
      break;
    case 'End':
      next = list[list.length - 1];
      break;
    case 'Enter':
    case ' ': {
      const details = row.querySelector<HTMLDetailsElement>(':scope > details');
      if (details) {
        details.open = !details.open;
        if (details.open && details.dataset.hydrated !== '1') {
          const parent = byId.get(Number(row.dataset.id));
          const children = details.querySelector<HTMLUListElement>(':scope > .list');
          if (parent?.children.length && children) renderChildren(children, parent);
        }
      }
      selectRow(row);
      updateHash();
      event.preventDefault();
      return;
    }
    default:
      return;
  }
  if (next) {
    event.preventDefault();
    selectRow(next, true);
    loadDetail(next);
    prefetchNeighbours(next);
    updateHash();
  }
});

let searchFrame = 0;
query.addEventListener('input', () => {
  clearTimeout(fullTimer);
  fullController?.abort();
  detailController?.abort();
  cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(() => {
    renderAutocomplete();
    localSearch();
  });
});
acList.addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('.ac-item');
  if (!item?.dataset.slug) return;
  query.value = item.dataset.slug;
  ac.classList.remove('open');
  query.setAttribute('aria-expanded', 'false');
  localSearch();
});
query.addEventListener('blur', () =>
  setTimeout(() => {
    ac.classList.remove('open');
    query.setAttribute('aria-expanded', 'false');
  }, 100),
);
category.addEventListener('change', () => {
  detailController?.abort();
  localSearch();
});
regex.addEventListener('change', () => {
  detailController?.abort();
  localSearch();
});
full.addEventListener('change', () => {
  detailController?.abort();
  localSearch();
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  localSearch();
});

document.getElementById('expBtn')?.addEventListener('click', () => {
  // Opening a suite hydrates its children, and those may be suites themselves, so repeat until a
  // pass changes nothing.  The pass cap only guards against a malformed (cyclic) catalog.
  for (let pass = 0, changed = true; changed && pass < 32; pass++) {
    changed = false;
    results.querySelectorAll<HTMLDetailsElement>('details:not([open])').forEach((d) => {
      bulkOpened.add(d);
      d.open = true;
      changed = true;
    });
    results.querySelectorAll<HTMLUListElement>('details[open] > .list').forEach((list) => {
      if (list.childElementCount) return; // already rendered (client hydration or full-text results)
      const parent = bySlug.get(list.closest<HTMLElement>('.row')?.dataset.slug ?? '');
      if (!parent) return;
      renderChildren(list, parent);
      changed = true;
    });
  }
  updateHash();
});
document.getElementById('colBtn')?.addEventListener('click', () => {
  results.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => {
    d.open = false;
  });
  updateHash();
});

query.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    query.focus();
    query.select();
  }
  if (event.key === '/' && document.activeElement === document.body) {
    event.preventDefault();
    query.focus();
    query.select();
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    query.focus();
    query.select();
  } else if (
    event.key === '/' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    document.activeElement === document.body
  ) {
    event.preventDefault();
    query.focus();
    query.select();
  }
});

function applyTheme(value: string) {
  document.documentElement.dataset.theme = value;
  localStorage.setItem('smpte-theme', value);
}
const savedTheme = localStorage.getItem('smpte-theme') || 'system';
theme.value = savedTheme;
applyTheme(savedTheme);
theme.addEventListener('change', () => applyTheme(theme.value));

localSearch();

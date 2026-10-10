import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const db = new Database('.data/searchindex.sqlite');
db.run('DROP TABLE IF EXISTS docs');
db.run('CREATE VIRTUAL TABLE docs USING fts5(slug UNINDEXED, text)');

const files = await Array.fromAsync(
  new Bun.Glob('**/*.pdf').scan({ cwd: '.data/lib', absolute: true }),
);
const insert = db.prepare('INSERT INTO docs(slug, text) VALUES (?, ?)');

function getSlug(name: string) {
  let m = name.match(/^latest_(.+)\.pdf$/i);
  if (m) return m[1].toLowerCase();
  m = name.match(/^doc_(.+?)_\d{8}-[a-z0-9-]+(?:_|\.pdf$)/i);
  return m?.[1].toLowerCase() ?? null;
}

// One tesseract thread per job: we already run one job per core.
const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
async function command(name: string, args: string[]) {
  try {
    const p = Bun.spawn([name, ...args], { stdout: 'pipe', stderr: 'ignore', env });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch {
    return null;
  }
}

async function pdfText(file: string) {
  const extracted = await command('pdftotext', ['-enc', 'UTF-8', file, '-']);
  const text = extracted ? extracted.replace(/\s+/g, ' ').trim() : '';
  if (text.length >= 40) return text;

  const dir = join(Bun.env.TMPDIR || Bun.env.TEMP || '/tmp', `smpte-ocr-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    if ((await command('pdftoppm', ['-png', '-r', '180', file, `${dir}/page`])) === null)
      return text;
    const images = readdirSync(dir)
      .filter((name) => /^page-.*\.png$/i.test(name))
      .map((name) => join(dir, name));
    const parts: string[] = [];
    for (const image of images)
      parts.push((await command('tesseract', [image, 'stdout', '-l', 'eng'])) ?? '');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Extract in parallel (this was ~8 min serial); results stay in file order so output is unchanged.
const texts: string[] = new Array(files.length).fill('');
let cursor = 0;
await Promise.all(
  Array.from({ length: navigator.hardwareConcurrency || 4 }, async () => {
    while (cursor < files.length) {
      const i = cursor++;
      if (!getSlug(files[i].split(/[\\/]/).pop()!)) continue;
      console.log(`Index ${files[i]}`);
      texts[i] = (await pdfText(files[i])).toLowerCase();
    }
  }),
);

const bySlug = new Map<string, string[]>();
for (const [i, file] of files.entries()) {
  const slug = getSlug(file.split(/[\\/]/).pop()!);
  if (!slug) continue;
  const text = texts[i];
  if (text.length < 40) continue;
  const list = bySlug.get(slug) ?? [];
  list.push(text);
  bySlug.set(slug, list);
}

db.transaction(() => {
  for (const [slug, texts] of bySlug) insert.run(slug, texts.join(' '));
})();
insert.finalize();
db.close();
console.log(`${bySlug.size} docs indexed in .data/searchindex.sqlite`);

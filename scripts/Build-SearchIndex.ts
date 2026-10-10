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
const decoder = new TextDecoder();

function getSlug(name: string) {
  let m = name.match(/^latest_(.+)\.pdf$/i);
  if (m) return m[1].toLowerCase();
  m = name.match(/^doc_(.+?)_\d{8}-[a-z0-9-]+(?:_|\.pdf$)/i);
  return m?.[1].toLowerCase() ?? null;
}

function command(name: string, args: string[]) {
  try {
    return Bun.spawnSync([name, ...args], { stdout: 'pipe', stderr: 'ignore' });
  } catch {
    return null;
  }
}

function pdfText(file: string) {
  const extracted = command('pdftotext', ['-enc', 'UTF-8', file, '-']);
  const text = extracted ? decoder.decode(extracted.stdout).replace(/\s+/g, ' ').trim() : '';
  if (text.length >= 40) return text;

  const dir = join(Bun.env.TMPDIR || Bun.env.TEMP || '/tmp', `smpte-ocr-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    if (!command('pdftoppm', ['-png', '-r', '180', file, `${dir}/page`])) return text;
    const images = readdirSync(dir)
      .filter((name) => /^page-.*\.png$/i.test(name))
      .map((name) => join(dir, name));
    const parts = images.map((image) => {
      const result = command('tesseract', [image, 'stdout', '-l', 'eng']);
      return result ? decoder.decode(result.stdout) : '';
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bySlug = new Map<string, string[]>();
for (const file of files) {
  const slug = getSlug(file.split(/[\\/]/).pop()!);
  if (!slug) continue;
  console.log(`Index ${file}`);
  const text = pdfText(file).toLowerCase();
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

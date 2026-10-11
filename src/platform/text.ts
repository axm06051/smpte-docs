// Pure text helpers shared by every slice. Keep it free of Bun/Node imports: the browser bundles it.
const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
export const escRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const pl = (n: number) => (n === 1 ? '' : 's');
export const tokens = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

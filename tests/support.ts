import { readdirSync, readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

// Server-side source of the web UI: the router plus every file of the library slice
// (the browser client lives in src/library/client and is read separately).
export const serverSource = () =>
  [
    'src/server.ts',
    ...readdirSync('src/library')
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/library/${f}`),
  ]
    .map(read)
    .join('\n');

import { readdirSync, readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

// Server-side source of the web UI: the router plus every file of the library slice
// (the browser client lives in src/library/client and is read separately).
export const serverSource = () =>
  [
    'src/server.ts',
    ...['src/library', 'src/views'].flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `${dir}/${f}`),
    ),
  ]
    .map(read)
    .join('\n');

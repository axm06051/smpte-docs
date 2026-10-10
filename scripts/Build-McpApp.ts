import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

if (!existsSync('dist')) mkdirSync('dist');
const result = await Bun.build({ entrypoints: ['src/mcp-app.ts'], minify: true });
if (!result.success) throw new Error(result.logs.map(String).join('\n'));

const fixi = readFileSync('node_modules/fixi-js/fixi.js', 'utf8');
const app = await result.outputs[0].text();
const html = readFileSync('src/mcp-app.html', 'utf8').replace(
  '<script type="module" src="./mcp-app.ts"></script>',
  `<script>${fixi}</script><script>${app}</script>`,
);
writeFileSync('dist/mcp-app.html', html);

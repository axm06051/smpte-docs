import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'SMPTE Search', version: '1.0.0' });
const root = document.getElementById('app')!;
const resultHtml = (result: { structuredContent?: unknown }) =>
  String((result.structuredContent as { html?: unknown } | undefined)?.html ?? '');

app.ontoolresult = (result) => {
  root.innerHTML = resultHtml(result);
};

root.addEventListener('submit', async (event) => {
  const form = event.target as HTMLFormElement;
  if (form.dataset.tool !== 'search_smpte') return;
  event.preventDefault();
  const q = new FormData(form).get('q')?.toString().trim();
  if (!q) return;
  const result = await app.callServerTool({ name: 'search_smpte', arguments: { q } });
  root.innerHTML = resultHtml(result);
});

await app.connect();

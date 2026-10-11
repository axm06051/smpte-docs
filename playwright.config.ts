import { defineConfig } from '@playwright/test';

const PORT = process.env.PORT ?? '3001';
const MCP_TOKEN = process.env.MCP_TOKEN ?? '';

export default defineConfig({
  testDir: './tests',
  timeout: 15_000,

  expect: {
    timeout: 5_000,
  },

  fullyParallel: true,

  retries: process.env.CI ? 1 : 0,

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    headless: true,
    // Tracing snapshots the DOM on every action; with a ~700-row page that made each test ~1.5s slower.
    trace: 'on-first-retry',
  },

  webServer: {
    command: 'bun run start',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      MCP_TOKEN,
    },
  },

  projects: [
    {
      name: 'setup',
      testMatch: '**/*.setup.ts',
    },
    {
      name: 'chromium',
      testMatch: '**/*.spec.ts',
      use: {
        browserName: 'chromium',
      },
      dependencies: ['setup'],
    },
  ],
});

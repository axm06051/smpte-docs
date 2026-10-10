import { test as setup } from '@playwright/test';

setup('global setup tasks', async () => {
  console.log('[TEST] Starting prerequisite tasks...');
  process.env.TEST_SESSION_ID = Date.now().toString();
  console.log('[TEST] Complete.');
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'on-first-retry', channel: 'chrome' },
  webServer: [
    {
      command: 'npm run test:e2e:api',
      url: 'http://127.0.0.1:8788/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run test:e2e:web',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

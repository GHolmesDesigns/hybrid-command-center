import { defineConfig } from '@playwright/test';

const API_PORT = '8788';
const WEB_PORT = '5174';
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
// Ignored on Windows, which has no signals, but on POSIX and in CI it gives the API server the
// chance to close its sockets and its database rather than being killed mid-write.
const gracefulShutdown = { signal: 'SIGTERM', timeout: 5_000 } as const;

export default defineConfig({
  testDir: './e2e',
  // One worker: every spec shares one API server and one SQLite file that is reset once per
  // run, so a second worker would let one spec's rows land in another spec's counts.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // `open: 'never'` matters more than it looks. The HTML reporter's default is to open the
  // report on failure, and opening it starts a web server that blocks until someone closes
  // it — the difference between a suite that finishes and a command that never returns.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: WEB_ORIGIN, trace: 'on-first-retry', channel: 'chrome' },
  webServer: [
    {
      name: 'api',
      // Spawned directly rather than through `npm run`: each layer between Playwright and
      // node is one more process that can survive the kill and keep the port held.
      command: 'node --experimental-strip-types e2e/start-server.ts',
      env: { PORT: API_PORT, DATABASE_PATH: './data/e2e.db', APP_ORIGIN: WEB_ORIGIN },
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown,
    },
    {
      name: 'web',
      // `--strictPort` so a busy port fails here and says so, rather than moving Vite to
      // 5175 and leaving Playwright to wait out its two-minute timeout on the old one.
      command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      env: { API_PORT },
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown,
    },
  ],
});

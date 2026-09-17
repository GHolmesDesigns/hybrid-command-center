import { defineConfig } from '@playwright/test';
import { E2E_API_PORT, E2E_WEB_PORT, e2eApiOrigin, e2eWebOrigin } from './e2e/endpoints.ts';

const API_PORT = String(E2E_API_PORT);
const WEB_PORT = String(E2E_WEB_PORT);
// Ignored on Windows, which has no signals, but on POSIX and in CI it gives the API server the
// chance to close its sockets and its database rather than being killed mid-write.
const gracefulShutdown = { signal: 'SIGTERM', timeout: 5_000 } as const;

export default defineConfig({
  testDir: './e2e',
  // The Windows runner is materially slower under load: the same critical workflow that takes
  // seconds locally has crossed Playwright's 30-second default there. Keep every assertion and
  // fail bounded, but give a single Windows CI flow enough time to finish instead of interrupting
  // the rest of the required suite. Local and Linux runs retain Playwright's default.
  timeout: process.env.CI && process.platform === 'win32' ? 60_000 : 30_000,
  // Playwright's default also collects `*.test.ts`, which would hand it the Vitest files
  // that sit beside the helpers they cover. `.spec.ts` is Playwright's, `.test.ts` is
  // Vitest's, and nothing has to live away from what it tests to keep the two apart.
  testMatch: '**/*.spec.ts',
  // One worker: every spec shares one API server and one SQLite file that is reset once per
  // run, so a second worker would let one spec's rows land in another spec's counts.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // `open: 'never'` matters more than it looks. The HTML reporter's default is to open the
  // report on failure, and opening it starts a web server that blocks until someone closes
  // it — the difference between a suite that finishes and a command that never returns.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: e2eWebOrigin, trace: 'on-first-retry', channel: 'chrome' },
  // Runs before Playwright's webServer plugin teardown, so both children can exit themselves
  // and skip the Windows `taskkill` path that otherwise deadlocks the runner.
  globalTeardown: './e2e/teardown.ts',
  webServer: [
    {
      name: 'api',
      // Spawned directly rather than through `npm run`: each layer between Playwright and
      // node is one more process that can survive the kill and keep the port held.
      command: 'node --experimental-strip-types e2e/start-server.ts',
      env: {
        PORT: API_PORT,
        DATABASE_PATH: './data/e2e.db',
        APP_ORIGIN: e2eWebOrigin,
        BUFFER_API_KEY: 'e2e-buffer-key',
        PUBLISH_NOW_EVIDENCE: '1',
        HCC_ASSISTANT_PROVIDER: 'stub',
        ASSISTANT_KEY_ENCRYPTION_KEY: 'e2e-assistant-encryption-key-32chars!!',
      },
      url: `${e2eApiOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown,
      // A full stdout pipe plus `taskkill` is how a passing Windows run used to hang. The
      // servers still log on stderr, which Playwright forwards.
      stdout: 'ignore',
    },
    {
      name: 'web',
      // Vite through its own API rather than its CLI, for the reason the API server is
      // started the same way: the CLI has no reason to stop when Playwright goes away, and
      // an interrupted run that leaves it holding 5174 blocks every run after it.
      command: 'node --experimental-strip-types e2e/start-web.ts',
      env: { API_PORT, WEB_HOST: '127.0.0.1', WEB_PORT, VITE_PUBLISH_NOW_EVIDENCE: '1' },
      url: e2eWebOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown,
      stdout: 'ignore',
    },
  ],
});

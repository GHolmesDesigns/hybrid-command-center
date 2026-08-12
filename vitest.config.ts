import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    coverage: { reporter: ['text'] },
    projects: [
      {
        test: {
          name: 'shared',
          environment: 'node',
          include: ['shared/**/*.test.ts'],
          setupFiles: ['./shared/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          // `e2e/` is included for the helpers under it, not for the specs. The two runners
          // are kept apart by suffix — `.spec.ts` is Playwright's, `.test.ts` is Vitest's —
          // which `playwright.config.ts` has to say out loud, because Playwright's default
          // collects both. Without this an E2E helper could only be tested from `server/`,
          // away from what it covers.
          include: ['server/**/*.test.ts', 'e2e/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['client/**/*.test.tsx'],
          setupFiles: ['./client/src/test-setup.ts'],
        },
      },
    ],
  },
});

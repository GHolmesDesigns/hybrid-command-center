import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // `text` so a reviewer reads the figures in the job log; `json-summary` so the
      // per-project totals below can be recomputed from `coverage/coverage-summary.json`
      // rather than eyeballed off the table, which is how the baselines were taken.
      reporter: ['text', 'json-summary'],
      // Named explicitly rather than left to default. The default measures only the files a
      // test happened to load, so deleting the last test for a module removes the module from
      // the report instead of dropping the number — coverage can rise as the suite shrinks.
      // With an explicit list an untested file counts as a zero, which is the honest reading.
      include: ['client/src/**/*.{ts,tsx}', 'server/**/*.ts', 'shared/**/*.ts', 'e2e/**/*.ts'],
      exclude: [
        // The tests and their scaffolding. Measuring a test measures nothing.
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/test-setup.ts',
        'client/src/App.test-setup.tsx',
        // Declarations carry no statements.
        '**/*.d.ts',
        // Process entry points. Both are a handful of lines that wire modules together and
        // then `listen()` or `render()`; everything they compose is measured where it lives.
        'server/index.ts',
        'client/src/main.tsx',
        // Playwright's half of `e2e/`: the specs, and the scripts it starts and stops the two
        // servers with. Another runner executes these, so under Vitest they can only read 0.
        // `e2e/database.ts` and `e2e/endpoints.ts` are the helpers Vitest does cover and they
        // stay measured.
        'e2e/**/*.spec.ts',
        'e2e/start-server.ts',
        'e2e/start-web.ts',
        'e2e/teardown.ts',
        'e2e/shutdown.fixture.ts',
        // Tested by spawning them as a child process, so the run that measures is not the run
        // that executes and both read 0 whether the tests pass or fail. `e2e/shutdown.test.ts`
        // and `server/scripts/check-version-bump.test.ts` are the gates on these two.
        'e2e/shutdown.ts',
        'server/scripts/check-version-bump.ts',
        // Operator commands — migrate, seed, backup, restore, rehearse, the Signal import.
        // Run by hand or by their own CI step, never by this suite; a threshold over them
        // would be a permanent zero that says nothing about whether they work.
        'server/scripts/**',
        // The real Drive adapter. `AGENTS.md` requires automated tests to use the mock
        // provider and never call Drive, so this file is unreachable from the suite by rule,
        // not by omission. `mock-provider.ts` is what the suite exercises instead.
        'server/drive/google.ts',
      ],
      // Per project rather than one global number, because the three environments fail
      // differently and a global figure lets a client regression hide behind server tests.
      // The globs are the three `projects` below — `e2e/` sits with `server/` because that is
      // the project whose `include` runs it. Each figure is the suite's own measurement on
      // this branch, floored to a whole percent; a round number would be a target rather than
      // a baseline, and this way a drop reads as a drop.
      thresholds: {
        // 99.20 statements / 96.21 branches / 100 functions / 100 lines
        'shared/**': { statements: 99, branches: 96, functions: 100, lines: 100 },
        // 92.42 statements / 85.68 branches / 95.51 functions / 93.70 lines
        '{server,e2e}/**': { statements: 92, branches: 85, functions: 95, lines: 93 },
        // 82.06–82.13 statements / 80.41–80.85 branches / 82.42–82.54 functions / 83.52–83.58 lines,
        // measured over two runs. One block in `ImportView.tsx` renders on some runs and not others,
        // which is worth about 0.65 of a point, so a floor is only raised where the measurement
        // clears it by more than that: the gate measures the suite rather than the coin flip.
        // Branches lands inside that margin of the next whole percent and so stays where it was.
        'client/src/**': { statements: 81, branches: 79, functions: 81, lines: 82 },
      },
    },
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

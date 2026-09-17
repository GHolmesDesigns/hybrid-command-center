import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// A green run must not mean "only my focused test ran" or "nothing was asserted".
// Inline projects do not inherit root test options, so apply this to each explicitly.
// Server tests also use Supertest assertions, which Vitest cannot count; see below.
// These catch accidental false passes, not weak assertions; see docs/testing.md.
const testIntegrity = {
  allowOnly: false,
  expect: { requireAssertions: true },
};

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
      include: [
        'client/src/**/*.{ts,tsx}',
        'scripts/**/*.ts',
        'server/**/*.ts',
        'shared/**/*.ts',
        'e2e/**/*.ts',
      ],
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
        // The Post Bridge probe's two live halves. `probe-post-bridge.ts` is argv, stdin, the
        // filesystem, and an exit code; `transport.ts` is `fetch` and a timeout. Everything they
        // compose — the guards, the request shapes, the parsing, the budget, the redaction, the
        // teardown — is measured where it lives, which is the whole reason the transport is an
        // injected seam. No automated test may load either file: one of them talks to Post Bridge.
        'scripts/probe-post-bridge.ts',
        'scripts/probe-post-bridge/transport.ts',
        // Owner-run production MCP smoke entry and its live fetch transport (C134). Everything they
        // compose — argument guards, claim scoring, matrix rendering — is measured in
        // `scripts/eval-mcp-smoke/*.test.ts` with an injected transport.
        'scripts/eval-mcp-smoke.ts',
        'scripts/eval-mcp-smoke/transport.ts',
        // Operator commands — migrate, seed, backup, restore, rehearse, the Signal import.
        // Run by hand or by their own CI step, never by this suite; a threshold over them
        // would be a permanent zero that says nothing about whether they work.
        'server/scripts/**',
        // The real Drive adapter. `AGENTS.md` requires automated tests to use the mock
        // provider and never call Drive, so this file is unreachable from the suite by rule,
        // not by omission. `mock-provider.ts` is what the suite exercises instead.
        'server/drive/google.ts',
      ],
      // Per source group rather than one global number, because the environments fail
      // differently and a global figure lets a client regression hide behind server tests.
      // The globs are the three `projects` below — `e2e/` sits with `server/` because that is
      // the project whose `include` runs it. Each figure is the suite's own measurement on
      // this branch, floored to a whole percent; a round number would be a target rather than
      // a baseline, and this way a drop reads as a drop. These are execution regression alarms,
      // not correctness scores or targets for adding tests. Review the missing behavior first;
      // do not add filler assertions or automatically ratchet thresholds. See docs/testing.md.
      thresholds: {
        // 97.06 statements / 89.10 branches / 99.21 functions / 98.24 lines. The Post Bridge probe,
        // measured over everything except its two live halves, which are excluded above. High
        // because the point of the injected transport is that the risky logic is reachable from a
        // test; a drop here means a wire shape or a guard has stopped being covered.
        'scripts/**': { statements: 97, branches: 89, functions: 99, lines: 98 },
        // 99.20 statements / 96.21 branches / 100 functions / 100 lines
        'shared/**': { statements: 99, branches: 96, functions: 100, lines: 100 },
        // 92.42 statements / 85.68 branches / 95.51 functions / 93.70 lines
        '{server,e2e}/**': { statements: 92, branches: 85, functions: 95, lines: 93 },
        // 82.58 statements / 80.33 branches / ~81.0 functions / 84.15 lines, after C76's role
        // controls and their tests. One block in `ImportView.tsx` renders on some runs and not
        // others, which is worth about 0.65 of a point, so a floor is only raised where the
        // measurement clears it by more than that: the gate measures the suite rather than the coin
        // flip. Lines is the one that does — 84.15 against a floor of 82 — so it goes to 83 and
        // keeps a point of headroom. Functions measures 80.99–81.0% and that margin is smaller
        // than run-to-run variation, so it drops to 80 (C228) rather than red-gating unrelated
        // cards. Statements and branches stay inside the same margin of the next whole percent.
        'client/src/**': { statements: 81, branches: 79, functions: 80, lines: 83 },
      },
    },
    projects: [
      {
        test: {
          ...testIntegrity,
          name: 'shared',
          environment: 'node',
          include: ['shared/**/*.test.ts'],
          setupFiles: ['./shared/test-setup.ts'],
        },
      },
      {
        test: {
          ...testIntegrity,
          // The Post Bridge probe. Its own project rather than a glob added to `server`, because
          // nothing under `scripts/` is application code and a probe test failing should read as a
          // probe failure.
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
      {
        test: {
          // Supertest's .expect(status/body) is a real assertion but is not counted by
          // Vitest's requireAssertions. Do not force filler expect() calls into these tests.
          // Vitest-only suites can use expect.hasAssertions() in beforeEach (e.g. conformance).
          allowOnly: false,
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
          ...testIntegrity,
          name: 'client',
          environment: 'jsdom',
          include: ['client/**/*.test.ts', 'client/**/*.test.tsx'],
          setupFiles: ['./client/src/test-setup.ts'],
        },
      },
    ],
  },
});

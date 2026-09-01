# Testing procedure

Tests protect observable behavior and safety boundaries. There is no target for test count,
assertion count, new test files per card, or a percentage increase per iteration. A smaller suite
that catches the relevant regressions is preferable to a larger suite that repeats implementation
details. Passing tests are evidence for the cases and environments exercised, not proof of a
correct or secure application.

## Before changing code

Write the intended behavior in the issue or PR before designing the assertions:

- Given this state and input, what must the operator see or the caller receive?
- What must be persisted, and what must remain unchanged?
- What plausible failure would harm data, access, identity, or provider accounts?
- Which existing test already protects that behavior? Extend it before adding another scenario.

For a bug fix, reproduce the reported symptom and make the regression assertion fail on the old
behavior for the expected reason. A setup/import error is not a reproduced defect. If reproduction
needs owner-only credentials or unavailable infrastructure, record that limitation rather than
claiming a regression test. Do not operate on production to create test evidence.

## Choose the smallest credible boundary

| Risk or behavior | Preferred evidence | Assertions that matter |
| --- | --- | --- |
| Pure dates, dependencies, normalization, status rules | Shared/domain unit test with explicit inputs | Independently specified expected result; meaningful boundary values such as local midnight, DST, empty input, or a dependency cycle |
| Local persistence, import, restore, idempotency | Service integration test using isolated SQLite | Read stored state after success, rollback or partial failure; exact retry behavior; unchanged unrelated rows and correct audit event |
| Auth, scopes, confirmation, revision checks | HTTP/MCP integration test through the real boundary | Allowed request succeeds; missing/wrong/expired identity, stale revision, or invalid confirmation refuses; refused writes leave relevant data and provider calls unchanged |
| UI interaction and error recovery | React test with network/provider seams mocked | Accessible action, visible result/error, submitted values; label the server outcome as mocked |
| Browser/server contract, navigation, drag/drop, focus | Playwright workflow against fixture server/database | Complete user outcome and persistence after reload; real browser interaction rather than an API call substituted for the interaction under test |
| Provider payload, response parsing, uncertain outcomes | Adapter/contract test with injected fake transport | Exact approved target and media, rejected malformed response, bounded cleanup, no retry of ambiguous writes |
| Real vendor capability, client setup, deployment | Separately authorized owner verification | Exact endpoint/store/client/version, dated result, safety limits and unresolved questions; never infer this from mock success |

Avoid testing the same branch in every layer. Use the unit layer for rule permutations, integration
for wiring and persistence, and a representative browser journey for user-facing behavior.
The milestone E2E requirement remains: cover its critical flow, not every unit-test permutation.

## Assertion review

Every test should name a behavior, not merely "covers method X". Review its expected values against
the requirement, not against a copy of the production algorithm.

- A success status alone does not prove a mutation happened. Read it back independently and check
  important untouched state. A refusal status alone does not prove the operation was harmless.
- Do not compute the expected answer with the function under test, or mock the rule being tested.
  Share fixture construction when useful; keep the expected business result independent.
- Use call-count assertions where the call itself is the contract: no provider write, no duplicate
  retry, or a bounded budget. For ordinary local writes, prefer observable state to internal calls.
- Parsing generated JSON/TOML and checking its consumer-required structure is stronger than finding
  an expected substring. Parsing alone still does not prove the target application accepts it.
- Await asynchronous assertions and actions. When asserting a callback, make it impossible for the
  test to pass if the callback never runs. Do not replace synchronization with sleeps or retries.
- Mock at the external seam, including failure and malformed-response cases where relevant. A
  mocked "Diagnostic passed" message proves display behavior, not a working external credential.
- Assertions in setup helpers are not evidence that the test's own intended outcome was checked.
  The runner's assertion-presence guard is only a backstop, not a semantic-quality score.
- The shared, scripts, and client projects require Vitest assertions. Server tests also use
  Supertest's real status/body assertions, which Vitest cannot count; do not add dummy `expect`
  calls to satisfy a counter. A server suite using Vitest assertions exclusively can apply
  `expect.hasAssertions()` in `beforeEach`, as the protocol conformance suite does.
- Register transport/platform-specific cases only where they exercise behavior. An early `return`
  inside a test can produce a false green case; it is not an acceptable way to exclude a scenario.
- Do not blanket-delete snapshots or call assertions: retain them when they protect a named
  contract. Remove or consolidate duplicates only after showing which remaining case detects the
  regression they protected.

## Prove a regression test can detect the fault

For changed high-risk rules, or when strengthening a suspicious test, perform a bounded fault
check in an isolated checkout. Temporarily make the specific plausible mistake: omit the write,
accept the stale revision, swap the account, or retain the previous value. Run the focused test.
It must fail at the intended outcome assertion, not because the file fails to load. Restore the
source in a `finally` block and rerun the same test green. Never leave the mutation in a commit.

Record the changed behavior, focused command, failure assertion, restored result, and limitations
in the PR. This is targeted mutation testing, not a new mutation-score quota or a requirement to
run every possible mutation on every card. A surviving mutation prompts investigation: it may be
a missing assertion, an equivalent change, or unreachable behavior. Do not add filler tests just
to label every mutation caught.

## Per-iteration execution and review

1. State the acceptance outcome and relevant failure/safety cases. Explain reuse, additions, or
   removal of tests. Documentation-only changes need no application test merely to increase counts.
2. Run the focused tests while developing, including the failing-before/fixed-after check for a
   reproducible bug. Use file/name filters; do not commit `.only`, disabled assertions, or skipped
   regressions. A quarantined flaky test needs a tracked reason, owner, and re-enable condition.
3. Before integration, run the full coverage suite, typecheck, lint, formatting, build, and required
   E2E/version gates. A filtered green run is not the full gate. Inspect failures before rerunning;
   a later green result does not erase a flaky first run.
4. Review the actual assertions and the test's independence from its mocks. For security-sensitive
   changes, explicitly inspect authorization, secrets/redaction, transaction safety, retry behavior,
   and external side effects. Dependency audit and static analysis complement tests; they do not
   prove the same things. A skipped CodeQL job is not a successful security scan.
5. Report local results, completed remote CI, and owner-run evidence separately, against the tested
   commit. Keep unresolved behavior and untested environments visible. Counts describe workload;
   the protected outcomes explain confidence.

## Coverage policy

Keep the current thresholds and exclusions in `vitest.config.ts`. They are regression alarms for
execution reach, not measures of assertion strength, security, or requirement completeness. A
100%-covered function can still return the wrong result under an untested input or weak assertion.

When coverage falls, inspect the changed uncovered branches and their risks. Add or improve a test
only when it protects meaningful behavior; simplify unreachable code when appropriate. Do not
lower a threshold, add exclusions, or write assertion-free calls to turn the gate green. If an
existing policy conflicts with a justified change, document the evidence for explicit policy review
instead of disguising the change as better coverage. Threshold increases require stable repeated
measurements and reviewed behavior coverage; they are never automatic or an iteration target.

Exclusions require a reason, remaining risk, and another verification route. In particular, testing
a mock Drive provider does not test the real adapter. Keep live provider calls out of automation;
consider injected transport tests for adapter parsing/guards and separately authorized owner probes.

## Commands and inventory

PowerShell commands below use `npm.cmd`; use `npm` on other shells. No new dependency is needed.

```powershell
# Runner-collected cases, including parameterized cases; listing is not test execution.
npm.cmd exec vitest -- list --json=test-results/unit-inventory.json

# Fast, bounded feedback; use the file relevant to the behavior being changed.
npm.cmd test -- server/mcp/workspace-write-matrix.test.ts

# Full CI-equivalent Vitest coverage suite, with a machine-readable result.
npm.cmd run test:coverage -- --silent=passed-only --reporter=default --reporter=json --outputFile.json=test-results/unit-results.json

npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
npm.cmd run test:e2e
```

Create `test-results` first if absent. It is ignored by Git. Keep inventory and result JSON outside
`coverage/`, which Vitest cleans at the start of a coverage run. Reports can contain test fixture
output or failure details; do not publish them without reviewing for secrets.

The four Vitest projects are `shared`, `scripts`, `server`, and `client`. Server includes integration
tests and the Vitest E2E helpers; client uses jsdom; neither count is a pure unit-test count. Browser
specs are collected separately by Playwright. Report collected, executed, passed, failed, skipped,
and todo cases distinctly. Inventory growth or reduction is not an acceptance criterion.

## References

- [Testing Library guiding principles](https://testing-library.com/docs/guiding-principles/): test
  through user-observable behavior.
- [Vitest assertion requirement](https://vitest.dev/config/expect): detects missing Vitest assertions,
  not incorrect expectations or assertions made by other libraries; concurrent tests must use their
  test-context `expect`.
- [Vitest focused-test policy](https://vitest.dev/config/allowonly): `.only` can otherwise pass locally.
- [Vitest project configuration](https://vitest.dev/guide/projects.html): apply project options
  explicitly rather than assuming they inherit from the root config.

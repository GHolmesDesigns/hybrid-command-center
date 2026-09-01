# Test procedure audit — 2026-08-30

## Conclusion

The app does not need a larger test count as a goal. It needs stronger evidence that assertions
protect intended behavior. The baseline suite passes, and several existing suites already verify
meaningful security, persistence, and failure boundaries. A focused fault experiment nevertheless
showed that an MCP checklist test could pass while the requested change was silently ignored.
Strengthening the existing test detected that fault without adding a test case.

Scope: isolated checkout of `ca046a8`, app `5.9.5`, from the saved `origin/main` reference. The shared
checkout was on `fix/422-claude-connector-guide` when this audit started. That branch, its connector
changes, and the earlier feasibility-report work were not modified. Counts and findings below
refer to the isolated baseline, not concurrent work or the deployed server.

## Inventory and measured baseline

Collected using Vitest's runner, so parameterized cases are counted as cases rather than estimated
from source-code occurrences of `it`. The complete baseline coverage run then executed the cases:
**2,550 passed; zero failed, skipped/pending, or todo; 209 files**.

| Vitest project | Cases | Files | What the count contains |
| --- | ---: | ---: | --- |
| Shared | 411 | 35 | Shared/domain rule tests |
| Scripts | 254 | 14 | Probe guards, fake transports, and operator-tool helpers |
| Server | 1,479 | 104 | Domain/service tests, SQLite and HTTP/MCP integration, and Vitest E2E helpers |
| Client | 406 | 56 | React/jsdom tests with mocked boundaries |
| Total | 2,550 | 209 | Mixed test levels, not 2,550 isolated unit tests |

Playwright separately collected **52 browser cases in 43 spec files**. Collection does not execute
the flows. Browser cases are not included in the Vitest total or Vitest coverage.

Baseline execution coverage, weighted by covered/total items within the configured source groups:

| Source group | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Shared | 99.53% | 96.50% | 100% | 100% |
| Scripts | 97.67% | 90.53% | 99.44% | 98.89% |
| Server + E2E helpers | 93.41% | 85.09% | 95.79% | 94.59% |
| Client | 82.73% | 79.35% | 82.16% | 84.66% |

All existing coverage thresholds passed. Server branch coverage has little headroom over its 85%
floor, and client branch coverage over 79%; this identifies execution margin, not a reason to add
quota-filling cases. No threshold or exclusion was lowered or raised by this audit.

The collected inventory had two repeated same-file titles (`shared/signal-media.test.ts` and
`server/config.test.ts`). Repeated parameterized titles are a diagnosis aid, not evidence of useless
tests; inspect the distinct inputs before consolidating. The baseline has no skipped/todo cases.
No judgment about the quality of every one of the 2,550 cases is implied by this sample audit.

## Findings and action

| Finding | Evidence | Action / disposition |
| --- | --- | --- |
| Some tests exercise writes without asserting the resulting state | `server/mcp/workspace-write-matrix.test.ts` asserted success envelopes for checklist completion and dependencies. A focused ignored-completion mutation survived all seven cases in that file | Strengthened existing cases to re-read completion, deletion, dependency/blocking state, and unchanged unrelated/refused tasks. No new cases |
| Client mocks can validate the screen while missing the operational requirement | Baseline `client/src/Settings.mcp-agents.test.tsx` supplies a successful operator-health payload, clicks Diagnostic, and expects a success message. Its rotate case checks request calls, not whether the new credential authenticates | The procedure requires explicit mock limits, failure-state assertions, and actual client/credential evidence for a setup claim. Connector implementation belongs to the concurrent work, not this audit |
| Generated-config substring assertions miss the consumer contract | Baseline `shared/mcp-client-config.test.ts` and `shared/mcp-client-guide.test.ts` find bearer/header strings and steps; they do not establish that a complete document is accepted by the named client | Require parsed structure and consumer-specific contract checks, plus separately identified real-client evidence. Do not treat a step count as successful onboarding |
| Assertion-free tests could pass; `.only` could pass locally | Vitest defaults allow a test with no `expect`, and permit `.only` outside CI. The four inline project configs had no local integrity policy | Added `allowOnly: false` to all projects and `expect.requireAssertions: true` to shared/scripts/client. Server also uses valid Supertest assertions, which Vitest cannot count, so it keeps that assertion style without filler. The Vitest-only conformance suite uses `expect.hasAssertions()` |
| Three transport cases passed without exercising anything | `server/mcp/protocol-conformance.test.ts` returned immediately for stdio in malformed HTTP batch, SSE replay, and one-shot HTTP cases | Register those cases only for HTTP. Removed three phantom passes, kept the real HTTP coverage and common transport cases |
| Coverage and “more tests” can become proxies for confidence | Existing instructions emphasized numeric floors and increases without requiring a named outcome/fault. README also described three projects although four are configured | Added `docs/testing.md`, revised AGENTS/README, and added a PR evidence template. Retained thresholds as execution alarms; no count targets, auto-ratchet, or filler assertions |
| Security assurance comes from several different checks | HTTP scope/limiter tests exercise refusals; provider inventory tests preserve prior rows after failure. Dependency audit is in the quality workflow. CodeQL is conditional on repository visibility/enablement | Preserve these complementary checks. Review auth, redaction, transaction/retry safety and real-provider boundaries explicitly; do not report an unrun/skipped security scan as passed |

Strong examples worth retaining:

- `server/publish/inventory.test.ts`, “writes nothing at all when a later page fails”: seeds old
  inventory, injects a later-page provider failure, and verifies the old IDs remain and the audit
  records failure. This protects behavior rather than merely exercising a branch.
- `server/mcp/http.test.ts`: requests cross the real HTTP boundary for scope refusal/allowance and
  persistent write limiting, including attempts across separate requests and changed labels.
- `server/auth/mcp-agent-credentials.test.ts`: checks hashed storage, identity, expiry and revocation
  through credential resolution. These do not by themselves cover two-request UI rotation.

## Fault experiment: same case count, better detection

Only in the isolated worktree, temporarily replaced the completion expression in
`server/workspace/writes.ts`, `updateChecklistItem`, with the old stored `item.completed` value.
The function still returned success and advanced normally, but ignored the requested completion.

| Stage | Focused command | Result |
| --- | --- | --- |
| Original matrix with the fault | `npm.cmd test -- server/mcp/workspace-write-matrix.test.ts` | 7 passed: this file missed the persistence regression |
| Strengthened matrix with the same fault | Same command | 1 failed, 6 passed: stored completion did not match `completed: true` / completed count 1 |
| Production source restored in `finally` | Same command | 7 passed |

The failing assertion was the new read-back check, not a syntax/import/setup error. The production
source was restored byte-for-byte; no runtime module remains changed. This experiment says this
particular test was weak. It does **not** say the mutation would survive the entire original suite,
and it does not establish a general mutation score.

Temporary sentinel runs verified the runner policy. The initial all-project assertion requirement
correctly rejected assertion-free probes, but a full run then rejected nine real Supertest-only
tests as well as three true no-op conformance cases. The nine were not assertion-free bugs: forcing
extra Vitest expectations into them would reward a counter rather than behavior. Final policy keeps
the automatic assertion requirement in shared/scripts/client and scopes it to the Vitest-only
conformance suite on the server. `.only` remains forbidden across all four projects.

Final sentinel checks rejected assertion-free cases in all three guarded projects and both
conformance transport instances (five expected failures), and rejected `.only` in all four
projects (four expected failures). All temporary cases were removed. An assertion-presence check cannot distinguish a meaningful
expectation from `expect(true).toBe(true)` or a setup-only assertion; human review and fault checks
remain necessary. The conformance cases are no longer collected on the inapplicable transport,
so the final verified suite has **2,547 cases**, three fewer than the original inventory, without
losing an exercised behavior or adding a skipped case.

## Procedure now supplied

The [testing procedure](../testing.md) asks each iteration to identify the expected outcome, relevant
failure/safety behavior, existing coverage, and the evidence boundary. Bug fixes should demonstrate
the expected regression failure before the fix and a pass afterward where reproducible. Changed
high-risk behavior gets a bounded fault check or a justified alternative. PR review records these
outcomes, not a target number of tests. All existing release gates and the milestone browser-flow
requirement remain in place.

The audit adds no dependency, mutation-testing service, production probe, or automatic coverage
threshold adjustment. It strengthens two existing test bodies, removes three no-op transport
instances, and adds runner safeguards rather than expanding the case count. Further test consolidation should be driven by duplicated behavior
and measured maintenance/runtime cost, with the surviving fault-detection evidence recorded.

## Validation and limitations

- Baseline full Vitest coverage: 2,550 passed, all coverage floors passed.
- Fault and runner-policy checks: results above; temporary mutations/probes removed.
- Final full Vitest coverage: **2,547 passed in 209 files; zero failed, skipped/pending, or todo;
  all existing coverage floors passed**. No case was added to meet a numeric target.
- Typecheck, lint, formatting, production build, and `git diff --check` passed. The build retained
  Vite's large-chunk warning; this audit did not change runtime bundling. Markdown remains excluded
  by the repository's Prettier policy and was reviewed directly.
- Validation used the existing installed dependencies resolved from the parent checkout, not a
  fresh `npm ci`. These are local results, not completed remote CI or release approval.
- Playwright was collected, not executed; no browser/runtime application behavior is changed here.
- No live provider, production database, or real credential was used. No remote CI or CodeQL run
  was triggered or certified, and no deployment state was inferred from local tests.
- The initial coverage invocation failed before test execution because its redirected log was
  placed in `coverage/`, which Vitest tries to clean. On Windows the open log caused `EBUSY`.
  Moving audit logs/results to ignored `test-results/unit-audit/` corrected the harness. This was
  an audit-command error, not an application failure or flaky test.
- Generated results/logs stay ignored in `test-results/unit-audit/`; they are not deliverables to
  publish. The recorded aggregates and fault descriptions above are the reviewable evidence.

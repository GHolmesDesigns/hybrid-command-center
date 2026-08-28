# MCP Capability and Defect Plan

**Drafted:** 27 August 2026
**Repository:** `GHolmesDesigns/hybrid-command-center`
**Baseline:** 5.4.2 (`main` at `8617968`) · production `https://hcc.gholmesdesigns.com`
**Consolidates:** [`claude-code-mcp-capabilities-report.md`](claude-code-mcp-capabilities-report.md),
[`codex-mcp-capabilities-report.md`](codex-mcp-capabilities-report.md),
[`cursor-mcp-agent-capabilities-report.md`](cursor-mcp-agent-capabilities-report.md)
**Governs:** [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) §9 catalog,
[`agent-coordination-plan.md`](agent-coordination-plan.md) §5

This is the delivery plan for everything the three capability reviews found: **five confirmed
defects and nineteen cards across five waves**, from the live rate-limiter bug to the agent
evaluation suite. It does not reopen the C105 trust boundary — provider publishing, Drive writes,
and permanent deletion stay out of MCP, and a handoff stays a request rather than a workflow engine.

---

## 1. Verified starting state

Every row below was checked against the tree at `8617968`, not taken from the reports.

| Claim | Verified | Evidence |
| --- | --- | --- |
| Seven coordination tools, one resource | Yes | `COORDINATION_TOOLS` in [`shared/mcp-agent-events.ts`](../shared/mcp-agent-events.ts); `COORDINATION_RESOURCE_DEFINITIONS` in [`server/mcp/resources.ts`](../server/mcp/resources.ts) |
| Zero workspace / Signal MCP tools | Yes | `tools/list` in [`server/mcp/stdio.ts:104`](../server/mcp/stdio.ts) maps `COORDINATION_TOOL_DEFINITIONS` only |
| Fresh session per HTTP POST | Yes | `const session = createMcpSession()` at [`server/mcp/http.ts:121`](../server/mcp/http.ts) |
| Limiter lives inside that session | Yes | `coordinationWrites` field in [`server/mcp/session.ts`](../server/mcp/session.ts) |
| No eleven-request HTTP test | Yes | 14 cases in [`server/mcp/http.test.ts`](../server/mcp/http.test.ts); none exercises limit accumulation |
| `clientRequestId` on post only | Yes | `postArgsSchema` in [`server/mcp/coordination.ts`](../server/mcp/coordination.ts); note/complete/cancel schemas omit it |
| Agent label is client-asserted per request | Yes | `applyAgentLabel` reads `x-agent-label` on every POST ([`server/mcp/http.ts:83`](../server/mcp/http.ts)) |

Two facts the reports did not record, found while grounding this plan — both are prerequisites,
covered by C121 and C122:

- **`workspace_dashboard_summary` has no owner module.** §9.2 of the decision record assigns it to
  `server/domain/dashboard`, which does not exist. The composition lives inline in the route handler
  at [`server/app.ts:1752`](../server/app.ts). Shipping the tool against today's tree would be a
  second implementation of the deadline buckets — exactly what "one tool, one service method"
  forbids.
- **The tool dispatcher is synchronous.** `callCoordinationTool` returns `McpToolCallResult`, and
  [`server/mcp/stdio.ts:118`](../server/mcp/stdio.ts) calls it without `await`. `PublishService.preview`
  ([`server/publish/service.ts:159`](../server/publish/service.ts)) is `async`. `signal_publish_preview`
  cannot land until the dispatch path is async end to end.

---

## 2. Confirmed defects

Five. D1 is reproduced live; the rest are source-verified.

### D1 — Network write rate limiting resets on every request · **P0**

**Where:** [`server/mcp/http.ts:121`](../server/mcp/http.ts).
**Behaviour:** `handleMcpHttpPost` builds a new `McpSession` per POST, so the rolling window in
[`server/mcp/rate-limit.ts`](../server/mcp/rate-limit.ts) starts empty every call. The documented
budget — 10 coordination writes per rolling minute
([`agent-coordination-plan.md`](agent-coordination-plan.md) §5.6, threat H2) — is enforced for
long-lived stdio sessions and is a no-op over HTTP, which has no persistent connection.
**Evidence:** eleven consecutive `coordination_claim_handoff` calls against production with one
bearer and one label all returned `FAILURE / Handoff not found`; none returned
`REFUSED / rate limit exceeded`. Reproduced live, corroborated by source review in all three reports.
**Fixed by:** C116.

> **The obvious fix reopens the bug under another name.** All three reports recommend keying the
> limiter on *bearer plus agent label*. Because the label is client-supplied on every request (D3),
> a client that varies `x-agent-label` mints a fresh 10-write bucket per call and the budget is
> defeated again. C116 therefore enforces a **per-credential ceiling that no label can widen**, with
> the per-label bucket nested inside it.

### D2 — Idempotency is incomplete · **P0**

**Where:** [`server/mcp/coordination.ts`](../server/mcp/coordination.ts).
**Behaviour:** only `coordination_post_handoff` accepts `clientRequestId`. A retry after a lost
response can append a duplicate note, and complete/cancel have no way to distinguish "retry of my
call" from "second attempt." §5.5 of the coordination plan already states the intended rule; the
tool schemas do not implement it.
**Fixed by:** C117.

### D3 — Agent identity is client-asserted, not server-bound · **P0**

**Where:** [`server/mcp/http.ts:83`](../server/mcp/http.ts).
**Behaviour:** one bearer plus any `x-agent-label` value is accepted. A credential issued for
`cursor-planning` can post, claim, and complete as `codex-release` by changing one header. On a
single workstation this was a labelling convention; on a public origin with cross-device agents it
is an impersonation path — and it is what makes D1's fix non-trivial.
**Fixed by:** C118 (C116 mitigates by ceiling).

### D4 — Completion is self-declared · **P1**

**Where:** `completeArgsSchema` in [`server/mcp/coordination.ts`](../server/mcp/coordination.ts) —
it is `claimArgsSchema`, a handoff ID and nothing else.
**Behaviour:** completing records a state change with no result summary, changed paths, PR or issue
reference, validation outcome, or blocker classification. In the live inbox, `claude-desktop`'s two
Week 5 handoffs are both `COMPLETED`; one succeeded and one was diagnosed then superseded, and
nothing but prose distinguishes them.
**Fixed by:** C125.

### D5 — Documentation contradicts the shipped system · **P1**

| Location | Says | Actually |
| --- | --- | --- |
| [`multi-agent-mcp-decision.md:3`](multi-agent-mcp-decision.md) | "decided, not implemented" | C111–C113 shipped |
| [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) §1.6 | network MCP deferred | shipped as C113, live on HTTPS |
| [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) §10 wave table | Wave 22 workspace tools precede Wave 23 coordination | coordination shipped first; workspace tools unbuilt |
| [`AGENTS.md`](../AGENTS.md) `server/mcp/` | "local stdio MCP surface" | stdio **and** authenticated HTTP |
| [`work-summary.md`](work-summary.md) | 16 Aug snapshot at 4.3.0 | 27 Aug, 5.4.2, production |

**Fixed by:** C119 (shipped).

---

## 3. Decisions this plan makes

The reports left four things ambiguous. Resolved here so no card has to relitigate them.

| # | Question | Decision |
| --- | --- | --- |
| 1 | `signal_queue_snapshot` or `signal_queue_health` in "the five reads"? | **Both ship.** §9.3 defines them as separate tools with separate owners; `readQueueHealth` and `listPostsInRange` both already exist, so the second costs almost nothing. The canonical set is six: `workspace_dashboard_summary`, `workspace_list_tasks`, `signal_list_posts`, `signal_queue_health`, `signal_queue_snapshot`, `signal_publish_preview`. |
| 2 | Is scoped agent identity P0 or P1? | **P0, Wave 25.** Not for its own sake — because D1's fix is incomplete while D3 stands, and shipping a limiter that a header rotation defeats would close the issue without closing the hole. |
| 3 | Do handoffs gain a lifecycle, or does a new entity carry it? | **A new entity.** `agent_work_sessions` holds leases, heartbeats, and checkpoints. A handoff is a request; a work session is an execution attempt. All three reports converge on this and the coordination plan's §4.3 non-goals require it. |
| 4 | Client-side packaging: one skill or three? | **One shared workflow, three thin packages.** The claim → work → prove policy is one document; Claude Code (`Skill`), Cursor (`.cursor/skills`), and Codex (plugin) each get a wrapper pointing at it. Three independent copies would drift the moment a tool is added. |

---

## 4. Waves and cards

Waves continue from 25 (Production cloud cutover, C114–C115). Cards continue from C115 (#363);
Wave 26 is milestone 39 (#366–#369), Wave 27 is 40 (#370–#374), Wave 28 is 41 (#375–#378),
Wave 29 is 42 (#379–#381), and Wave 30 is 43 (#382–#384). Every card follows
[`AGENTS.md`](../AGENTS.md): one card per branch, `changes/<issue>.md` while draft, version assigned
at finalization. Estimates are sequential hours for one implementer.

| Wave | Cards | Theme | Estimate | Browser coverage |
| --- | --- | --- | --- | --- |
| 26 — MCP hardening | C116–C119 | Close the confirmed defects | **14–26 h** | `e2e/mcp-agent-credentials.spec.ts` (C118) |
| 27 — Context and reads | C120–C124 | Make agents able to see the workspace | **14–30 h** | `e2e/mcp-health-panel.spec.ts` (C124) |
| 28 — Prove the work | C125–C128 | Evidence, policy, resumability | **13–27 h** | `e2e/mcp-work-session.spec.ts` (C128) |
| 29 — Safe mutation | C129–C131 | Bounded writes behind concurrency control | **12–24 h** | `e2e/mcp-signal-planning.spec.ts` (C130) |
| 30 — Streams and proof | C132–C134 | Change feeds, protocol conformance, evaluation | **12–24 h** | `e2e/mcp-change-feed.spec.ts` (C132) |

**Total: 65–131 hours across 19 cards.** Sizes use the repository's own label bands: `size-s`
under 1 hour, `size-m` 1–3, `size-l` 4–8, `size-xl` 8–12.

---

## Wave 26 — MCP hardening

### C116 — Persist the network write rate limit

**Type / branch:** `fix/366-mcp-http-rate-limit`
**Size:** M · **Estimate:** 1–3 h · **Wave:** 26 · **Labels:** `bug` `tier-1-security` `size-m`
**Issue:** [#366](https://github.com/GHolmesDesigns/hybrid-command-center/issues/366)
**Depends on:** — · **Blocks:** nothing (C118 refines the key)

#### Problem

D1. Confirmed live against production.

#### Scope

- A process-lifetime `McpWriteLimiterRegistry` constructed once where the handler is mounted
  ([`server/app.ts:843`](../server/app.ts)), following the `LoginRateLimiter` precedent in
  [`server/auth/login-rate-limit.ts`](../server/auth/login-rate-limit.ts) — a keyed map of rolling
  windows, not per-request state.
- **Two nested budgets.** The outer one is keyed on credential identity alone — `bearer.tokenHash`,
  or `session.tokenHash` for cookie auth — and **cannot be widened by any label**. The inner one is
  keyed on credential plus normalized `agent_label` and preserves today's per-agent 10/minute
  reading. The outer ceiling is what survives D3.
- TTL pruning on both, bounded entry count, and documented process-restart behaviour (budgets reset;
  stated, not hidden).
- `retryAfterMs` in the structured refusal, computed from the oldest stamp in the offending window.
- Stdio keeps its existing per-session limiter; the registry is a network-transport concern.

#### Out of scope

SQLite-backed limiter state, cross-instance coordination, changing the 10/minute figure.

#### Acceptance criteria

- [ ] Eleven separate `POST /api/mcp` write calls with one bearer and one label: calls 1–10 succeed
      or fail on their own merits, call 11 returns `REFUSED` with `retryAfterMs`.
- [ ] Eleven separate POSTs with one bearer and **eleven different labels** still hit the outer
      ceiling — the regression this fix exists to prevent.
- [ ] Two distinct bearers do not share a budget.
- [ ] Reads are never limited.
- [ ] `REFUSED` is recorded to `mcp_agent_events` with the agent label that was asserted.
- [ ] `COORDINATION_WRITE_LIMIT_PER_MINUTE` remains the single source of the figure.

---

### C117 — Idempotency and structured errors on every coordination mutation

**Type / branch:** `fix/367-mcp-idempotent-mutations`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 26 · **Labels:** `bug` `tier-3-schema` `size-l`
**Issue:** [#367](https://github.com/GHolmesDesigns/hybrid-command-center/issues/367)
**Depends on:** C116 (#366) — shares the error envelope

#### Problem

D2, plus the untyped `error` string on `McpToolCallResult` — agents parse prose to decide whether to
retry.

#### Scope

- `clientRequestId` accepted on `coordination_add_note`, `coordination_complete_handoff`, and
  `coordination_cancel_handoff`, matching the existing `postHandoff` rule: an exact repeat returns
  the original outcome and writes nothing further.
- One structured error shape on every refusal and failure, carried in JSON-RPC `error.data`:
  `code`, `retryable`, `retryAfterMs`, `currentState`, `requiredAction`. `code` is a closed union in
  `shared/`, not a free string.
- The human-readable `error` string stays, unchanged, beside the structured data.
- §5.5 of [`agent-coordination-plan.md`](agent-coordination-plan.md) updated in the same branch —
  the note row says "no client-request idempotency in v1" and stops being true here.

#### Acceptance criteria

- [ ] Replaying a note with the same `clientRequestId` returns the first note and appends nothing.
- [ ] Replaying complete/cancel returns the original terminal row, not a second state flip.
- [ ] Every `REFUSED` and `FAILURE` path carries a `code` from the closed union.
- [ ] Rate-limit refusals carry `retryable: true` and a `retryAfterMs`; authorization refusals carry
      `retryable: false`.

---

### C118 — Scoped agent registry and server-bound identity

**Type / branch:** `feat/368-mcp-agent-registry`
**Size:** XL · **Estimate:** 8–12 h · **Wave:** 26 · **Labels:** `enhancement` `tier-1-security` `tier-3-schema` `size-xl`
**Issue:** [#368](https://github.com/GHolmesDesigns/hybrid-command-center/issues/368)
**Depends on:** C116 (#366), C117 (#367)
**Browser coverage:** `e2e/mcp-agent-credentials.spec.ts`

#### Problem

D3. One operator bearer plus a free-text header is the whole identity model, and cross-device agents
are now real.

#### Scope

- `agent_registrations` — immutable ID, editable display label, created/last-used timestamps, last
  origin.
- Credentials one-way hashed and bound to an **agent ID**, not only to an operator browser session:
  independent expiry, last-used time, and revocation that does not require a password change or
  disturb other agents.
- **The effective agent label is resolved server-side from the credential.** `x-agent-label` becomes
  advisory: a mismatch is refused rather than honoured. This is the line that closes D3, and it is
  what makes C116's inner bucket trustworthy.
- Capability scopes: `coordination:read`, `coordination:write`, `workspace:read`, `workspace:write`.
  Wave 25 issues and enforces the first two; the workspace scopes are declared now so Wave 26 and 28
  tools have a gate to sit behind rather than a migration to run.
- Settings UI listing active credentials — label, scopes, last used, revoke — never redisplaying a
  secret.
- The existing operator-session bearer stays as the bootstrap path, mapped to a built-in
  registration with full coordination scope, so no connected agent breaks on upgrade.

#### Out of scope

Multi-operator accounts, agent tenancy inside the workspace, OAuth for agents.

#### Acceptance criteria

- [ ] A credential bound to agent A cannot write as agent B by changing `x-agent-label` — refused,
      audited, with a structured `code`.
- [ ] Revoking one agent leaves other connected agents working.
- [ ] A credential without `coordination:write` is refused on writes and allowed on reads.
- [ ] Expiry is enforced independently of the operator session lifetime.
- [ ] The secret is shown exactly once, at issuance.
- [ ] E2E: operator registers an agent, copies a credential, sees a last-used time after the agent
      calls, revokes it, and sees the next call fail.

---

### C119 — Reconcile the MCP record with what shipped

**Type / branch:** `docs/369-mcp-doc-reconciliation`
**Size:** M · **Estimate:** 1–3 h · **Wave:** 26 · **Labels:** `docs` `size-m`
**Issue:** [#369](https://github.com/GHolmesDesigns/hybrid-command-center/issues/369)
**Depends on:** — (run it first; it costs nothing and every later card cites it)

#### Scope

- Commit the three capability reports and `work-summary.md`, which are untracked today.
- Fix every row in D5's table: decision-record status header, §1.6 network deferral, §10 wave
  ordering, the `AGENTS.md` `server/mcp/` bullet.
- Add this plan to the cross-reference lists in the decision record and the coordination plan.
- Refresh `work-summary.md` to the 5.4.2 production baseline, or mark it explicitly as an August 16
  historical snapshot. Either is fine; a document that reads as current and is not, is not.
- Record the §9 catalog's two corrections found in §1 above: `workspace_dashboard_summary`'s owner is
  a module C121 creates, and `signal_publish_preview` requires the async dispatcher from C122.

#### Acceptance criteria

- [ ] No committed document states that network MCP is deferred or unimplemented.
- [ ] `npm run format:check` passes on every touched file (the operating manual stays excluded per
      #357).
- [ ] Every §9 tool row names an owner module that exists, or names the card that creates it.

---

## Wave 27 — Context and reads

### C120 — Capability descriptor and `hcc://workspace/context`

**Type / branch:** `feat/370-mcp-workspace-context`
**Size:** M · **Estimate:** 1–3 h · **Wave:** 27 · **Labels:** `enhancement` `size-m`
**Issue:** [#370](https://github.com/GHolmesDesigns/hybrid-command-center/issues/370)
**Depends on:** C118 (#368)

#### Problem

An unfamiliar session must already know tool names, label rules, and approval boundaries. There is
no first read after connect.

#### Scope

- `hcc://workspace/context` — a compact, bounded snapshot: app version, capability version, active
  clients and projects, overdue and blocked task counts, open handoffs, queue-health headline,
  available tools with their scopes, and the approval boundaries that are never available over MCP.
- A hard response-size ceiling with documented truncation, and filters so an agent can ask for less.
- `system_capabilities` tool returning the same descriptor as a tool call, for clients whose
  resource support is weak.
- Composition only — no new domain logic, no counting rule that is not already
  `shared/deadlines.ts`.

#### Acceptance criteria

- [ ] One read after connect tells an agent what it may do and what it must not.
- [ ] The response stays under the ceiling with a workspace of at least 500 tasks; truncation is
      declared in the payload rather than silent.
- [ ] Capability version changes when the tool set changes, and the descriptor is generated from the
      tool registry rather than hand-listed.

---

### C121 — Extract the dashboard summary from the route handler

**Type / branch:** `chore/371-dashboard-domain-module`
**Size:** M · **Estimate:** 1–3 h · **Wave:** 27 · **Labels:** `chore` `size-m`
**Issue:** [#371](https://github.com/GHolmesDesigns/hybrid-command-center/issues/371)
**Depends on:** — · **Blocks:** C122 (#372)

#### Problem

The deadline buckets, counts, and recent-project ordering are composed inline at
[`server/app.ts:1752`](../server/app.ts). `workspace_dashboard_summary` cannot map to one service
method because there is no method.

#### Scope

- `server/domain/dashboard.ts` — a framework-free function taking `Db` and `now`, returning today's
  exact payload. Same buckets, same active-scope rule, same `compareProjectActivity` ordering.
- `GET /api/dashboard` becomes a call to it. **No behaviour change**, and the existing app tests are
  the proof.

#### Acceptance criteria

- [ ] `GET /api/dashboard` returns byte-identical payloads before and after for a fixed fixture.
- [ ] No deadline rule moves into or stays in a React component or a route handler.
- [ ] No changelog-visible behaviour change; the fragment says so.

---

### C122 — Async dispatcher and the read-only workspace and Signal tools

**Type / branch:** `feat/372-mcp-read-tools`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 27 · **Labels:** `enhancement` `size-l`
**Issue:** [#372](https://github.com/GHolmesDesigns/hybrid-command-center/issues/372)
**Depends on:** C118 (#368), C120 (#370), C121 (#371)
**Delivers:** MCP-C106 core from [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) §9

#### Scope

- Make the tool dispatch path async: `callCoordinationTool` and its `tools/call` caller in
  [`server/mcp/stdio.ts`](../server/mcp/stdio.ts) return and await promises. Prerequisite for any
  tool touching `PublishService`.
- Split the dispatcher into a **tool registry** keyed by name, with each entry declaring its class
  (R/L/I), required scope, and owner. `tools/list` and C120's descriptor both generate from it.
  Seven hardcoded coordination tools do not scale to sixty.
- The six read tools, each mapping to exactly one existing service function:

| Tool | Owner | Maps to |
| --- | --- | --- |
| `workspace_dashboard_summary` | `server/domain/dashboard.ts` | C121's function |
| `workspace_list_tasks` | `server/repositories.ts` | `listActiveTasks` with bounded filters |
| `signal_list_posts` | `server/signal/read.ts` | `listPostsInRange` |
| `signal_queue_snapshot` | `server/signal/read.ts` | `listPostsInRange`, unscheduled + upcoming |
| `signal_queue_health` | `server/signal/queue-health.ts` | `readQueueHealth` |
| `signal_publish_preview` | `server/publish/service.ts` | `PublishService.preview` |

- Every read is capped and paginated; every read is gated on `workspace:read`.
- `signal_publish_preview` makes **no** provider or Drive network call — preflight reads stored MIME
  types, per [`AGENTS.md`](../AGENTS.md). A test asserts the mock provider is never contacted.

#### Out of scope

Any write. Any tool from §9.4 or §9.6.

#### Acceptance criteria

- [ ] `tools/list` returns thirteen tools, generated from the registry.
- [ ] No read tool re-implements a rule that lives in a domain module.
- [ ] `signal_publish_preview` contacts no provider and no Drive path — asserted, not assumed.
- [ ] A tool without `workspace:read` scope is refused with a structured `code`.
- [ ] Redaction covers every new payload.

---

### C123 — Subject context and search

**Type / branch:** `feat/373-mcp-subject-context`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 27 · **Labels:** `enhancement` `size-l`
**Issue:** [#373](https://github.com/GHolmesDesigns/hybrid-command-center/issues/373)
**Depends on:** C122 (#372)

#### Problem

Large list responses waste an agent's context. A handoff names one subject; the agent should be able
to ask for that subject once.

#### Scope

- `workspace_get_subject_context(subjectType, subjectId)` over the same subject vocabulary the
  handoff row already uses (`AGENT_HANDOFF_SUBJECT_TYPES`) — one bounded package: the entity, its
  parents, its blocking dependencies, related handoffs, and its recent activity.
- `workspace_search(query)` with hard result caps and typed results.

#### Acceptance criteria

- [ ] A claimed handoff's subject resolves in one call, with no list-and-filter loop.
- [ ] Result caps are enforced server-side and declared in the payload.
- [ ] An unknown subject returns a structured not-found, not an empty success.

---

### C124 — Connection diagnostics and the operator MCP health panel

**Type / branch:** `feat/374-mcp-health-panel`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 27 · **Labels:** `enhancement` `size-l`
**Issue:** [#374](https://github.com/GHolmesDesigns/hybrid-command-center/issues/374)
**Depends on:** C118 (#368), C120 (#370)
**Browser coverage:** `e2e/mcp-health-panel.spec.ts`

#### Problem

The 500-row mutation audit is forensic evidence, not a health view. Production availability, refusal
rates, and stale claims are now operational concerns, and a failing agent connection has no
diagnosis path short of reading the audit table.

#### Scope

- `system_connection_status` — a read-only tool that verifies auth, protocol negotiation, resolved
  agent identity and scopes, `tools/list`, `resources/list`, one bounded resource read, server
  version, capability version, and server clock. **It never creates a handoff to prove connectivity.**
- A Settings panel over `mcp_agent_events` and the C118 registry: recently active agents, last
  success and last failure per agent, request and refusal counts, rate-limit events, bounded error-code
  summary, and stale claims.
- A safe "test connection" action running the diagnostic without a workspace write.

#### Acceptance criteria

- [ ] The diagnostic changes no workspace data — asserted by comparing table checksums across a run.
- [ ] The panel distinguishes "no agent has connected" from "agents connected and all failed."
- [ ] Stale `CLAIMED` handoffs past the §5.4 threshold are visible without a query.
- [ ] E2E: operator opens the panel, runs the test, sees a result and a last-used timestamp.

---

## Wave 28 — Prove the work

### C125 — Evidence-backed completion

**Type / branch:** `feat/375-coordination-completion-evidence`
**Size:** M · **Estimate:** 1–3 h · **Wave:** 28 · **Labels:** `enhancement` `tier-3-schema` `size-m`
**Issue:** [#375](https://github.com/GHolmesDesigns/hybrid-command-center/issues/375)
**Depends on:** C117 (#367)

#### Problem

D4. `COMPLETED` currently means "an agent ended the handoff."

#### Scope

- `coordination_complete_handoff` requires a result summary and accepts optional changed paths,
  commit/PR/issue references, validation commands with outcomes, and remaining risks.
- A machine-readable outcome classification — succeeded, partially succeeded, blocked, superseded —
  so the two Week 5 handoffs in the live inbox stop being indistinguishable.
- Evidence is stored on the handoff row and surfaced in the C112 operator inbox and C124 panel.
- Bounded field sizes per §4.2; every free-text field passes through `redactSecrets`.

#### Acceptance criteria

- [ ] Completing without a summary is refused with a structured `code`.
- [ ] Evidence is visible in the operator inbox without opening the notes.
- [ ] A superseded completion is distinguishable from a successful one by field, not by prose.
- [ ] Completion still touches no task, Signal post, or provider path — §4.3 unchanged.

---

### C126 — MCP prompts

**Type / branch:** `feat/376-mcp-prompts`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 28 · **Labels:** `enhancement` `size-l`
**Issue:** [#376](https://github.com/GHolmesDesigns/hybrid-command-center/issues/376)
**Depends on:** C122 (#372), C125 (#375)

#### Scope

`prompts/list` and `prompts/get`, with `start_claimed_work`, `review_project_status`,
`prepare_handoff`, `verify_before_complete`, and `triage_signal_queue`. Each encodes project rules —
claim before work, evidence before complete, publishing is never MCP — so those rules stop living
only in tool descriptions and docs.

#### Acceptance criteria

- [ ] Prompts are generated from the tool registry, so a prompt cannot name a tool that does not exist.
- [ ] `verify_before_complete` names the C125 evidence fields.
- [ ] Every prompt states the provider-publish and Drive-write boundary.

---

### C127 — Agent skill packages and guided connection setup

**Type / branch:** `feat/377-mcp-agent-skills`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 28 · **Labels:** `enhancement` `size-l`
**Issue:** [#377](https://github.com/GHolmesDesigns/hybrid-command-center/issues/377)
**Depends on:** C118 (#368), C126 (#376)

#### Scope

- One canonical workflow document — the claim → work → prove loop, approval boundaries, and when to
  stop for the operator — with three thin wrappers: Claude Code (`Skill`), Cursor
  (`.cursor/skills`), Codex (plugin manifest). Per §3 decision 4, one policy, three packages.
- A guided connection flow: register an agent in Settings, issue a scoped credential once, generate
  the client configuration for that identity, run C124's diagnostic, and see the agent's last
  successful connection in HCC. This replaces today's manual translation of login, bearer issuance,
  endpoint URL, and label.
- The Claude-Code-specific bridge named in
  [`claude-code-mcp-capabilities-report.md`](claude-code-mcp-capabilities-report.md) — a background
  loop polling the inbox for handoffs directed at this agent — is documented in the skill as an
  operator-opt-in pattern. It is client-side; it adds no server code and no scheduler to HCC.

#### Acceptance criteria

- [ ] A session with no prior HCC knowledge can connect, claim, and complete correctly using the
      skill alone.
- [ ] The three packages reference one workflow document; none restates the policy.
- [ ] The generated configuration works against production without hand-editing.

---

### C128 — Leased work sessions

**Type / branch:** `feat/378-agent-work-sessions`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 28 · **Labels:** `enhancement` `tier-3-schema` `size-l`
**Issue:** [#378](https://github.com/GHolmesDesigns/hybrid-command-center/issues/378)
**Depends on:** C125 (#375)
**Browser coverage:** `e2e/mcp-work-session.spec.ts`

#### Problem

A crashed agent leaves `CLAIMED` forever; §5.4 makes operator cancel the only escape hatch. There is
no resume context after a lost session.

#### Scope

- `agent_work_sessions`, separate from `agent_handoffs` per §3 decision 3, with lifecycle
  `PLANNED → CLAIMED → IN_PROGRESS → NEEDS_INPUT | BLOCKED | COMPLETED | ABANDONED`.
- Tools: `work_start`, `work_heartbeat`, `work_checkpoint`, `work_request_input`, `work_mark_blocked`,
  `work_release`, `work_complete`, `work_get_resume_context`.
- A session records handoff and subject, agent ID, lease expiry, base revision, branch or worktree,
  current step, structured evidence, and validation results.
- Lease expiry surfaces the handoff as reclaimable — **it does not silently reassign work.** An
  expired lease is a visible state, not an automatic transfer.
- `work_complete` feeds C125's evidence fields; the handoff's own state machine is untouched.

#### Out of scope

Workflow DAGs, broadcast chat, automatic reassignment, cross-workspace federation.

#### Acceptance criteria

- [ ] A session with a missed heartbeat marks the handoff reclaimable without changing its state row
      behind the operator's back.
- [ ] `work_get_resume_context` returns enough for a fresh session to continue: subject, step,
      checkpoints, base revision.
- [ ] The handoff row gains no lifecycle column; a handoff is still a request.
- [ ] E2E: operator sees a stale session in the inbox and reclaims it.

---

## Wave 29 — Safe mutation

### C129 — Optimistic concurrency

**Type / branch:** `feat/379-mcp-revision-preconditions`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 29 · **Labels:** `enhancement` `tier-3-schema` `size-l`
**Issue:** [#379](https://github.com/GHolmesDesigns/hybrid-command-center/issues/379)
**Depends on:** C117 (#367), C122 (#372) · **Blocks:** C130 (#380), C131 (#381)

#### Problem

Once agents write, two agents — or an agent and the UI — race. This must land **before** the first
write tool, not after.

#### Scope

- `revision` or `updatedAt` precondition on every mutable entity a write tool will touch.
- A stale write returns a structured conflict carrying the current revision and the fields that
  changed, so an agent can re-plan rather than retry blindly.
- Reads from Wave 26 start returning the revision so an agent has one to send.

#### Acceptance criteria

- [ ] A write with a stale revision is refused with `code: conflict` and the current revision.
- [ ] A write with no revision is refused rather than silently last-write-wins.
- [ ] UI writes and MCP writes share one precondition path.

---

### C130 — Bounded local writes

**Type / branch:** `feat/380-mcp-local-write`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 29 · **Labels:** `enhancement` `size-l`
**Issue:** [#380](https://github.com/GHolmesDesigns/hybrid-command-center/issues/380)
**Depends on:** C129 (#379)
**Delivers:** MCP-C107 · **Browser coverage:** `e2e/mcp-signal-planning.spec.ts`

#### Scope

Class-L tools from §9.2, §9.3, and §9.7: create and update task, checklist and dependencies, create
and update project, create and update Signal draft, set slot, update variants and targets, duplicate
post, acknowledge queue alerts, settings updates. Each carries an idempotency key, an expected
revision, a dry-run preview where the change is compound, an explicit confirmation token for
destructive operations, a structured before/after summary, and an `mcp_agent_events` row.

#### Out of scope

Provider publish and every §9.3 exclusion. Drive writes. Merge commit and import commit (C131).
Permanent deletion of a client.

#### Acceptance criteria

- [ ] Every write is gated on `workspace:write`.
- [ ] Destructive operations refuse without the confirmation token.
- [ ] Signal writes go through `service.ts` and never through `SignalProvider`.
- [ ] Signal writes record no `integration_events` row — it is local data.
- [ ] E2E: an agent creates a Signal post over MCP and the operator sees it in the planner.

---

### C131 — Preview, import, and integration writes

**Type / branch:** `feat/381-mcp-integration-write`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 29 · **Labels:** `enhancement` `size-l`
**Issue:** [#381](https://github.com/GHolmesDesigns/hybrid-command-center/issues/381)
**Depends on:** C130 (#380)
**Delivers:** MCP-C108

#### Problem

The live `OPEN` handoff — a Week 5 Signal import that failed as pasted text and was retried as a
workbook — is exactly this class of work, and no agent can run it through MCP today.

#### Scope

- Two-step preview and commit for playbook and Signal import, carrying the preview hash, and for the
  client merge, under the existing field-by-field choice rule.
- `signal_resolve_drive_media` and the recheck tools from §9.4 — metadata and version fingerprint
  only, no bytes.
- `drive_sync` and the provider refresh tools from §9.6, under C105's separate 6/minute
  integration-write budget and writing `integration_events`.
- `files_browse_project` (§9.5), read-only, project-scoped by ID.

#### Out of scope

Provider submit, apply, cancel, publish-now. Any Files widening. Any byte storage.

#### Acceptance criteria

- [ ] A commit refuses when the preview hash no longer matches the workspace.
- [ ] Integration writes record `integration_events` and respect the 6/minute budget separately from
      the coordination budget.
- [ ] `files_browse_project` refuses any folder ID outside the project's own folder and its recorded
      `drive_steps`.
- [ ] No provider write path is reachable from any MCP tool — asserted by a test over the registry.

---

## Wave 30 — Streams and proof

### C132 — Cursor-based change feeds

**Type / branch:** `feat/382-mcp-change-feeds`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 30 · **Labels:** `enhancement` `size-l`
**Issue:** [#382](https://github.com/GHolmesDesigns/hybrid-command-center/issues/382)
**Depends on:** C122 (#372), C128 (#378)
**Browser coverage:** `e2e/mcp-change-feed.spec.ts`

#### Problem

Agents poll the whole inbox. Agents also sleep, disconnect, rotate credentials, and survive
deployments — so a socket is not the answer; a durable cursor is.

#### Scope

- `hcc://coordination/changes?after=<cursor>` and `hcc://workspace/changes?after=<cursor>` with
  monotonic cursors, replay after reconnect, bounded retention, and an explicit
  "cursor expired; reload snapshot" result rather than a silent gap.

#### Acceptance criteria

- [ ] An agent that disconnects and returns receives exactly the changes it missed.
- [ ] A cursor older than retention returns the expired result, never a partial feed.
- [ ] Cursors survive a process restart.
- [ ] E2E: operator posts a handoff in the UI; a feed read after a prior cursor returns it.

---

### C133 — Streamable HTTP lifecycle and protocol conformance

**Type / branch:** `feat/383-mcp-transport-conformance`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 30 · **Labels:** `enhancement` `size-l`
**Issue:** [#383](https://github.com/GHolmesDesigns/hybrid-command-center/issues/383)
**Depends on:** C132 (#382)

#### Problem

The HTTP adapter handles one request and one same-call response. No server notifications, no resource
subscriptions, no progress, no cancellation propagation — which is why C132's cursors are needed and
why some clients cannot connect at all.

#### Scope

- Stateful streamable-HTTP lifecycle: session initialization and continuation, server notifications,
  resource update notifications, progress, and cancellation propagation.
- A conformance suite over initialization negotiation, notification handling, malformed batches,
  cancellation, large payloads, reconnect, and resource-list stability.
- Sequenced **after** C132 deliberately: cursors work for sleeping laptops and restarted processes,
  and notifications are the optimization on top, not the substitute.

#### Acceptance criteria

- [ ] The conformance suite passes over both stdio and HTTP from one set of cases.
- [ ] A client that only supports one-shot JSON-RPC still works unchanged.
- [ ] Notifications never replace the durable cursor as the source of truth.

---

### C134 — Agent evaluation suite

**Type / branch:** `chore/384-mcp-agent-evaluation`
**Size:** L · **Estimate:** 4–8 h · **Wave:** 30 · **Labels:** `chore` `size-l`
**Issue:** [#384](https://github.com/GHolmesDesigns/hybrid-command-center/issues/384)
**Depends on:** C133 (#383)

#### Scope

A repeatable evaluation over a non-production fixture, covering: discovering the right task; avoiding
claimed work; recovering after a lost response; rejecting a stale revision; resuming from a
checkpoint; reporting validation evidence; respecting the publish and Drive boundary; avoiding
duplicate mutations after retries; handling an expired lease; producing a useful operator handoff;
connecting as two independent agent identities; **proving one credential cannot impersonate another
by changing a header**; revoking one agent without interrupting others; and recovering a cursor after
a restart. Scored on task success, evidence completeness, latency, and token use.

Plus a bounded, read-only production smoke check that creates nothing.

#### Acceptance criteria

- [ ] The suite runs against a fixture database and never against production.
- [ ] Every defect in §2 has a case that fails on the pre-fix commit.
- [ ] The production smoke check performs discovery and one bounded read, and writes nothing.

---

## 5. Sequencing

```text
C119 (docs) ─────────────────────────────── run first; blocks nothing, cites everything

C116 ──► C117 ──► C118 ──┬──► C120 ──┬──► C122 ──┬──► C123
                         │           │           │
              C121 ──────┴───────────┘           ├──► C124
                                                 │
                                    C125 ──┬──► C126 ──► C127
                                           │
                                           └──► C128 ──┐
                                                       │
                                    C129 ──► C130 ──► C131
                                                       │
                                                C132 ──► C133 ──► C134
```

**Critical path:** C116 → C117 → C118 → C120 → C122 → C129 → C130 → C131 → C132 → C133 → C134.

**Parallelizable:** C119 and C121 have no dependencies and can start immediately. C123 and C124 are
independent of each other once C122 lands. C125 → C126 → C127 runs beside C128.

**Stop-and-ship points.** Wave 26 alone closes every confirmed defect and makes the network endpoint
safe to hand to an agent other than the operator's own — that is the minimum viable stop. Wave 27
alone makes agents useful for triage and planning. Neither wave leaves the system in a worse state
than today if the next wave never starts.

---

## 6. Rules every card inherits

From [`AGENTS.md`](../AGENTS.md) and the C105 boundary. Restated because MCP is where they are
easiest to erode:

- **One tool, one service method.** A tool that re-implements a domain rule is a second write path.
- **Provider publishing is never reachable from MCP** — not by tool, not by side effect of
  completing a handoff, not through import. §6.2 of the coordination plan is non-negotiable.
- **Files stays browse-only.** No upload, download, move, rename, or delete tool, in any wave.
- **Every mutation tool records `mcp_agent_events`; every integration write records
  `integration_events`.** Never both for the same fact, never a credential in either.
- **Redaction covers every new payload** — `redactToolResult` applies to tool results and resource
  bodies alike.
- **Every new tool is declared in the registry with its class and required scope.** A tool that is
  not in the registry does not appear in `tools/list`, the capability descriptor, or the prompts.
- **Coverage thresholds are measured floors and get raised, never lowered** to make a branch pass.
- **Every wave adds at least one `e2e/` spec** — assigned in §4's table.

---

## 7. What stays out

Unchanged from C105 §9.3 and the coordination plan's §4.3, and not reopened by any card here:

| Capability | Reason |
| --- | --- |
| Provider publish, publish-now, apply, reconcile, cancel | Human-confirmed UI only |
| Drive upload, download, move, rename, delete | Files is a read boundary |
| Permanent client deletion | Archive is the rule |
| Raw credential or provider response dumps | Structured fields and redaction only |
| Broadcast chat, workflow DAGs, cross-workspace federation | Deferred in the coordination plan |
| Multi-operator accounts, agent tenancy | One operator workspace; labels are not permissions |

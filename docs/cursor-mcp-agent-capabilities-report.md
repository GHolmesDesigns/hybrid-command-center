# Cursor MCP Agent Capabilities Report

**Reviewed:** 27 August 2026  
**Repository:** `GHolmesDesigns/hybrid-command-center`  
**Reviewed version:** ~5.4.2  
**Audience:** Cursor agents and operators integrating Hybrid Command Center via MCP

## Executive summary

The MCP foundation is solid — local stdio, authenticated `POST /api/mcp`, label-gated
writes, secret redaction, append-only audit, and an operator inbox in Settings. The useful
agent surface is still **coordination-only**: seven handoff tools and one inbox resource.

Cursor can already coordinate with Claude and Codex (labels such as `cursor-planning`,
`claude-desktop`, `codex-release`), but it cannot yet inspect or mutate the workspace
through MCP. Planned workspace and Signal tools (**MCP-C106–C108**) are not implemented.
HTTP write rate limiting also fails to bind across requests, so the stated 10/minute budget
does not protect network MCP the way it protects a long-lived stdio session.

The best next move is not a wall of CRUD. Prefer: harden the transport, add compact context
resources and a small read surface, require evidence on complete, then teach Cursor the
claim → work → prove loop via MCP prompts and a project skill.

| Metric | Count |
| --- | --- |
| MCP tools live | 7 |
| Resources | 1 (`hcc://coordination/inbox`) |
| Open handoffs (at review) | 1 |
| Workspace / Signal MCP tools | 0 |

## Verdict

> Foundation is secure and well-tested. The gap is between “Cursor connected” and “Cursor
> can safely understand, execute, resume, and prove useful work.”

Related Codex-oriented twin: [`docs/codex-mcp-capabilities-report.md`](codex-mcp-capabilities-report.md).  
Decision and catalog: [`docs/multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md).  
Coordination plan: [`docs/agent-coordination-plan.md`](agent-coordination-plan.md).

---

## Shipped vs planned

| Card | Status | Role |
| --- | --- | --- |
| C105 | Decision | Trust boundary + tool catalog |
| C109 | Plan | Handoff primitives / threat model |
| C110 | Shipped | Domain + SQLite + HTTP seed/cancel |
| C111 | Shipped | Seven MCP tools + inbox resource |
| C112 | Shipped | Settings operator inbox UI |
| C113 | Shipped | Authenticated `POST /api/mcp` |
| MCP-C106 | **Not built** | Stdio scaffold + read tools |
| MCP-C107 | **Not built** | Signal and workspace local-write tools |
| MCP-C108 | **Not built** | Preview, import, and integration-write tools |

Decision doc §9 remains the target catalog. Wave 22 docs that imply workspace tools precede
coordination are stale relative to the coordination-first path that actually shipped.

### Cursor wiring today

[`.cursor/mcp.json`](../.cursor/mcp.json) runs `npm run mcp` with
`MCP_AGENT_LABEL=cursor-planning`. The live Cursor namespace is
`user-hybrid-command-center` (same seven tools plus `mcp_auth`).

---

## Current MCP surface

### Tools

| Tool | Class | Behavior |
| --- | --- | --- |
| `coordination_list_handoffs` | Read | List; optional `state` filter |
| `coordination_get_handoff` | Read | One handoff + notes |
| `coordination_post_handoff` | Write | Create OPEN; optional `clientRequestId` idempotency |
| `coordination_claim_handoff` | Write | Directed label or open-pool first claim |
| `coordination_complete_handoff` | Write | Claimer only; never publishes or contacts Drive |
| `coordination_cancel_handoff` | Write | Poster or claimer from OPEN/CLAIMED |
| `coordination_add_note` | Write | Append note (refused on CANCELLED) |

### Resource

| URI | Purpose |
| --- | --- |
| `hcc://coordination/inbox?state=open` | Snapshot of OPEN + CLAIMED handoffs (newest first) |

Also accepts `hcc://coordination/inbox` without a query. Agents poll; there are no
subscriptions or push notifications.

### Identity, limits, audit

- **Writes** require a non-empty `agent_label` (stdio: `MCP_AGENT_LABEL` / init meta /
  client name; HTTP: `x-agent-label`).
- **Rate limit:** 10 coordination writes per minute per MCP session — enforced for
  long-lived stdio sessions; **not** across separate HTTP POSTs (see below).
- **Audit:** `mcp_agent_events`, append-only, newest 500 retained; successful reads may
  skip audit; summaries go through secret redaction.

Central implementations:

- [`server/mcp/coordination.ts`](../server/mcp/coordination.ts)
- [`server/mcp/stdio.ts`](../server/mcp/stdio.ts)
- [`server/mcp/http.ts`](../server/mcp/http.ts)
- [`server/mcp/resources.ts`](../server/mcp/resources.ts)
- [`server/agent-coordination/service.ts`](../server/agent-coordination/service.ts)

---

## Live coordination snapshot

Captured via `coordination_list_handoffs` during this review (newest first):

| State | From → To | Subject | Summary |
| --- | --- | --- | --- |
| OPEN | claude-desktop → open pool | signal_post | Week 5 import retry via `.xlsx` (pasted-text captions failed) |
| COMPLETED | claude-desktop → claude-desktop | signal_post | Week 5 pasted-text import (diagnosed, then superseded) |
| COMPLETED | claude-desktop → cursor-planning | freeform | Connectivity test leg 2 |
| COMPLETED | cursor-planning → codex-release | freeform | Connectivity test leg 1 |

The open handoff is exactly the class of work MCP-C108 would close end-to-end: import
preview/commit that agents cannot run through MCP today.

---

## Principal gaps

### 1. Network write limiting resets on every request

`handleMcpHttpPost` constructs a fresh session per POST. The rolling limiter lives inside
that session, so one tool call per HTTP request receives a new 10-write allowance every
time. Highest-priority hardening item (also called out in the Codex report).

### 2. MCP can coordinate work but cannot perform most work

`tools/list` advertises only coordination. Tasks, projects, clients, Signal schedule,
calendar, queue health, Files browse, analytics, inventory, and import remain HTTP/UI only.
Completing a handoff does not apply workspace changes.

### 3. Completion is self-declared

`coordination_complete_handoff` changes state without requiring a result summary, paths,
PR/issue refs, validation outcomes, or remaining risks. Operators cannot distinguish
“finished successfully” from “agent ended the handoff.”

### 4. Claims have no lease

CLAIMED remains until complete or cancel. No expiry, heartbeat, renewal, voluntary release,
or `NEEDS_INPUT`. Safe but labor-intensive when a Cursor chat or process dies.

### 5. Discovery is implementation-oriented

Unfamiliar sessions must already know tool names, label rules, and approval boundaries. No
MCP prompts and no high-level onboarding resource such as `hcc://workspace/context`.

### 6. Idempotency is incomplete

`clientRequestId` exists on post only — not on note, complete, or cancel.

### 7. Doc drift

Decision/plan headers that still say the whole MCP story is “not implemented” are stale for
C111–C113. Wave 22→23 dependency ordering does not match the coordination-first path that
landed.

---

## Capabilities to add (Cursor-focused)

Effort: **S** small · **M** medium · **L** large.

### Priority 0 — Correctness and protocol hardening

#### Persistent HTTP write rate limit — S

**Why:** Each `POST /api/mcp` creates a fresh session, so the budget never accumulates
across Cursor HTTP calls.

**Deliver:** Limiter keyed by bearer/session + `agent_label`; cleanup; eleven-request
integration test; `retryAfterMs` in structured errors.

**Cursor fit:** Cursor often issues one tool call per HTTP request; without this, network
MCP is under-protected while stdio looks fine.

#### Mutation idempotency + structured errors — M

**Why:** Only `postHandoff` has `clientRequestId`. Retries after lost responses can
double-note or confuse state.

**Deliver:** `clientRequestId` on note / complete / cancel; error shape with `code`,
`retryable`, `retryAfterMs`, `currentState`, `requiredAction`.

**Cursor fit:** Agent chats and Autopilot retries are lossy; idempotent tools are safe to
re-invoke.

#### Evidence-backed complete — S

**Why:** Complete is self-declared.

**Deliver:** Required result summary; optional paths, PR/issue refs, validation outcomes,
remaining risks.

**Cursor fit:** Pairs with Cursor PR/diff workflows — complete should cite the branch, PR
URL, or gate results.

### Priority 1 — Make Cursor immediately useful

#### `hcc://workspace/context` resource — M

**Why:** Agents must already know tool names and scan the whole app.

**Deliver:** Compact snapshot — version, overdue tasks, open handoffs, queue health,
capability list; size ceiling and filters.

**Cursor fit:** First read after connect — like `AGENTS.md`, but live and bounded.

#### Five read-only workspace / Signal tools (MCP-C106 core) — M

**Why:** Agents can hand work off but cannot inspect the workspace through MCP.

**Deliver:**

- `workspace_dashboard_summary`
- `workspace_list_tasks`
- `signal_list_posts`
- `signal_queue_snapshot` / `signal_queue_health`
- `signal_publish_preview`

**Cursor fit:** Lets `cursor-planning` triage and plan without leaving chat or scraping the
UI.

#### Purpose-built subject context + search — M

**Why:** Large list tools waste tokens; handoffs need one package per subject.

**Deliver:** `workspace_get_subject_context(subjectType, subjectId)`;
`workspace_search(query)` with hard result caps.

**Cursor fit:** Matches Cursor’s prefer-small-context pattern — one call instead of N
list-and-filter loops.

#### MCP prompts + Cursor skill — S

**Why:** Workflow policy lives only in docs; unfamiliar sessions misuse claim/complete
order.

**Deliver:** Prompts such as `start_claimed_work`, `review_project_status`,
`prepare_handoff`, `verify_before_complete`, `triage_signal_queue`; a Cursor skill that
teaches when to inspect, claim, checkpoint, validate, complete, or stop for operator
approval.

**Cursor fit:** Native surfaces — `.cursor/skills` and MCP prompts show up in agent
discovery.

### Priority 2 — Robust agent work sessions

#### Claim leases + work sessions — L

**Why:** Crashed agents leave CLAIMED forever.

**Deliver:** Lease expiry / heartbeat; `work_start`, `work_checkpoint`,
`work_request_input`, `work_mark_blocked`, `work_release`, `work_complete`; keep the work
session separate from the handoff row (handoff = request; session = execution attempt).

**Cursor fit:** Chats die and resume; leases and checkpoints make multi-turn Autopilot
recoverable.

#### Optimistic concurrency (revision) — M

**Why:** Two agents (or UI + agent) can race once writes exist.

**Deliver:** `revision` / `updatedAt` precondition on mutable entities; structured conflict
with current revision.

**Cursor fit:** Critical once Cursor and Claude both mutate via MCP.

### Priority 3 — Safe local mutation

#### Bounded local writes (MCP-C107) — L

**Why:** After reads and concurrency controls are stable.

**Deliver:** Create/update task and Signal draft; set slot; variants/targets; acknowledge
alerts. Exclude provider publish and Drive writes.

**Cursor fit:** Cursor becomes an operator coworker for planning; publish stays
human-confirmed in the UI.

#### Preview / import / media resolve (MCP-C108) — L

**Why:** The live OPEN handoff is exactly this class of work.

**Deliver:** Import preview/commit; publish preview; Drive media resolve/recheck — still no
byte storage and no Files widening.

**Cursor fit:** Closes Claude → Cursor handoffs (for example Week 5 import) without pasting
into the UI.

### Priority 4 — Event-driven coordination

#### Change feeds (replace inbox polling) — L

**Why:** Protocol is one-shot JSON-RPC; agents poll the whole inbox.

**Deliver:** `hcc://coordination/changes?after=<cursor>`; workspace changes; replay;
expired cursor → reload snapshot.

**Cursor fit:** Background agents or loops can watch directed work without burning tokens.

---

## Keep out of MCP

| Capability | Reason |
| --- | --- |
| Provider publish / publish-now | Human-confirmed UI only |
| Drive upload / move / rename / delete | Files stays browse-only |
| Raw credential or provider dumps | Redaction + structured audit only |
| Broadcast chat / workflow DAGs | Deferred in the coordination plan |

---

## Suggested delivery sequence

1. Fix HTTP limiter identity and add the eleven-request test.
2. Reconcile decision/plan docs with shipped C111–C113.
3. Add capability/version and compact `hcc://workspace/context` resources.
4. Ship the five read-only workspace and Signal tools.
5. Add structured completion evidence and idempotency on every coordination mutation.
6. Add MCP prompts and a Cursor HCC skill.
7. Introduce leased work sessions and revision checks.
8. Add carefully bounded local writes, then import/preview.
9. Add cursor-based change feeds once polling hurts.
10. Expand only after agents demonstrate reliable claim → work → prove behavior.

---

## Highest-leverage next three

1. **Persist HTTP rate limits** — correctness for network MCP.
2. **Ship `hcc://workspace/context` + five reads** — make Cursor immediately useful.
3. **Evidence on complete + Cursor skill/prompts** — teach the claim → work → prove loop.

---

## Design target

> **MCP server for authoritative operations + compact resources for context + a Cursor
> skill for workflow policy + structured work sessions for resumability and evidence.**

Do not turn handoffs into a workflow engine. A handoff is a request; a work session is an
execution attempt.

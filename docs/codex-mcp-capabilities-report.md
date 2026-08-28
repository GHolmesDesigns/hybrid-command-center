# Codex and MCP Capability Report

**Reviewed:** 27 August 2026  
**Repository:** `GHolmesDesigns/hybrid-command-center`  
**Reviewed version:** 5.4.2  
**Production origin:** `https://hcc.gholmesdesigns.com`

## Executive summary

Hybrid Command Center is at version **5.4.2**, with local `main` matching `origin/main` at commit
`8617968`. It now lives in production at `https://hcc.gholmesdesigns.com`. The public origin resolves,
serves the Hybrid Command Center client, and presents the operator-password login boundary before
the workspace opens. At review time, GitHub had no open pull requests and one open issue: [#284 —
enable the analytics window after sufficient provider
history](https://github.com/GHolmesDesigns/hybrid-command-center/issues/284), which is intentionally
blocked and deferred.

The production deployment changes MCP from a workstation convenience into a potential shared agent
control plane. Authenticated network MCP can now coordinate Codex sessions running on different
machines against one authoritative cloud workspace. The foundation is secure and well-tested, but
its useful agent surface remains narrow: it exposes seven coordination tools and one inbox resource,
while the planned workspace and Signal tools have not been implemented.

The best next move is not simply adding more CRUD calls. First harden the hosted MCP identity,
rate-limit, observability, and credential lifecycle. Then build a robust Codex work-session layer
around the existing domain services: capability discovery, compact context resources, atomic claims
with leases, structured checkpoints, idempotent mutations, and verifiable completion evidence.

## Cloud deployment impact

The deployed origin surfaces capabilities that were previously only architectural possibilities:

- **One authoritative remote workspace.** Codex sessions no longer need to run on the machine that
  owns the SQLite file. They can connect to the hosted instance and see the same handoff state.
- **Cross-device agent coordination.** A Codex session on one workstation can post work for an agent
  on another workstation through the network MCP endpoint.
- **Revocable remote access.** MCP bearers inherit the operator session's idle expiry, absolute
  expiry, logout, password-change, and restore revocation behavior.
- **Same-origin security boundary.** The UI, API, authentication, and MCP endpoint share the
  production HTTPS origin behind Caddy; the Node process remains on loopback.
- **Central operational continuity.** EBS persistence, off-site S3 backups, health checks, systemd,
  and production monitoring make durable agent checkpoints and resumable work realistic product
  features rather than workstation-only metadata.

This also raises the risk level. On local stdio, a mislabeled or noisy agent primarily affected one
workstation. On hosted MCP, identity mistakes, retry storms, stale claims, or oversized reads can
affect every connected agent and the production workspace.

## Current MCP status

### What is implemented

- Local stdio MCP through `npm run mcp`.
- Authenticated same-origin `POST /api/mcp`.
- A live production origin at `https://hcc.gholmesdesigns.com`.
- Operator-session or revocable bearer authentication.
- CSRF enforcement for cookie-authenticated requests.
- Explicit `agent_label` identity for coordination writes.
- Seven handoff tools:
  - `coordination_list_handoffs`
  - `coordination_get_handoff`
  - `coordination_post_handoff`
  - `coordination_claim_handoff`
  - `coordination_complete_handoff`
  - `coordination_cancel_handoff`
  - `coordination_add_note`
- One resource: `hcc://coordination/inbox?state=open`.
- Atomic first-claim semantics and directed-agent authorization.
- Idempotency for posting handoffs through `clientRequestId`.
- Secret redaction and append-only MCP mutation audit.
- A 500-row audit retention policy.
- UI inbox for operator inspection and cancellation.
- Provider publishing remains excluded from MCP.

The central implementations are:

- [`server/mcp/coordination.ts`](../server/mcp/coordination.ts)
- [`server/mcp/stdio.ts`](../server/mcp/stdio.ts)
- [`server/mcp/http.ts`](../server/mcp/http.ts)
- [`server/mcp/resources.ts`](../server/mcp/resources.ts)
- [`server/agent-coordination/service.ts`](../server/agent-coordination/service.ts)

### Validation result

The focused MCP suite passed:

- **6 test files**
- **47 tests**
- Coordination domain/service, stdio protocol, HTTP authentication, revocation, and rate-limit
  primitives all passed.

This validates the tested behavior, but not the network rate-limit lifecycle described below.

## Principal findings

### 1. Network write limiting resets on every request

The HTTP handler constructs a fresh `McpSession` for every POST in
[`server/mcp/http.ts`](../server/mcp/http.ts). The rolling limiter lives inside that object in
[`server/mcp/session.ts`](../server/mcp/session.ts).

Consequently, a client making one tool call per HTTP request receives a new 10-write allowance every
time. The stated network protection therefore does not operate as a true per-bearer,
per-operator-session, or per-agent rolling limit.

Recommended correction:

- Key the network limiter by bearer/session identity plus agent label.
- Store limiter state in a bounded server-side registry or SQLite.
- Define cleanup and process-restart behavior.
- Add an HTTP integration test sending eleven separate requests.
- Return retry timing in structured error data.

This is the highest-priority hardening item.

### 2. The transport is a minimal JSON-RPC HTTP adapter

The implementation supports one request and one same-call response. It does not currently provide a
complete stateful streamable-HTTP lifecycle, server notifications, resource subscriptions, progress
notifications, or cancellation propagation.

That is adequate for basic tool calls, but limits compatibility and forces inbox polling. The
limitation is documented in [`server/mcp/resources.ts`](../server/mcp/resources.ts).

### 3. MCP can coordinate work but cannot perform most work

The current server advertises only the coordination definitions through `tools/list`. The manual
confirms "seven tools, coordination only" and that Signal tools are not built.

The broader design already specifies workspace and Signal tools—including clients, projects, tasks,
calendar, queue health, post planning, and publish previews—in
[`docs/multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md). That document's top-level "not
implemented" status is now partly stale because coordination and network transport have shipped.

### 4. Completion is self-declared, not evidence-backed

`coordination_complete_handoff` changes the handoff state but does not require:

- A result summary.
- Changed file paths.
- Commit or pull-request reference.
- Validation commands and outcomes.
- Remaining risks.
- A machine-readable failure or blocker classification.

The separation from actual workspace mutations is sound, but completion should carry evidence so an
operator or receiving agent can distinguish "finished successfully" from "agent ended the handoff."

### 5. Claims have no lease or liveness model

A claimed handoff remains claimed until manually completed or cancelled. There is no:

- Claim expiry.
- Heartbeat.
- Renewal.
- Voluntary release.
- `NEEDS_INPUT` state.
- Stale-claim indication in the MCP result.

This is safe but labor-intensive when an agent process crashes.

### 6. Discovery is too implementation-oriented

An unfamiliar Codex session must already know tool names, workflow order, identity requirements, and
approval boundaries. MCP currently has no prompt templates or high-level onboarding resource.

OpenAI now positions plugins as bundles that can combine skills, MCP servers, and optional UI, and
recommends exposing only task-relevant tools with concise descriptions. See [OpenAI
Developers](https://developers.openai.com/) and the [current model
guidance](https://developers.openai.com/api/docs/guides/latest-model).

### 7. Remote agent identity is not independently manageable

The network bearer is bound to an operator session, while `x-agent-label` is supplied by the client
on each request. This is a reasonable first transport boundary, but it does not give the operator a
durable registry of agent identities or independently scoped credentials.

For a hosted control plane, add:

- Named agent registrations with immutable IDs and editable display labels.
- One-way-hashed credentials bound to an agent ID, not only to an operator browser session.
- Explicit expiry, last-used time, origin/IP metadata, and manual revocation.
- Capability scopes such as `coordination:read`, `coordination:write`, `workspace:read`, and
  `workspace:write`.
- A UI that lists active credentials without ever displaying their secret again.
- Rotation that does not require changing the operator password or revoking unrelated agents.

The current bearer flow can remain the bootstrap path while scoped agent credentials are added.

### 8. Hosted MCP needs first-class operational visibility

The production deployment makes MCP availability, latency, refusal rates, and retry behavior
operational concerns. The existing 500-row mutation audit is useful forensic evidence, but it is not
a health view.

Add an operator-visible MCP status panel containing:

- Connected or recently active agent identities.
- Last successful request and last failure.
- Request counts, refusal counts, and rate-limit events by agent.
- Tool latency and bounded error-code summaries.
- Stale claims and work sessions missing heartbeats.
- Current protocol and capability version.
- A safe connection-test action that performs discovery and a read without changing workspace data.

## Codex capabilities to add

### Priority 0 — Correctness and protocol hardening

#### Persistent network rate limiting

Enforce budgets across HTTP requests, keyed to authenticated identity and agent label.

#### Mutation idempotency everywhere

Add `clientRequestId` to notes, completion, cancellation, and future workspace writes. Cache or return
the original outcome for exact retries.

#### Optimistic concurrency

Put `revision` or `updatedAt` preconditions on mutable entities. A stale agent should receive a
structured conflict containing the current revision.

#### Structured errors

Standardize error data:

- `code`
- `retryable`
- `retryAfterMs`
- `currentState`
- `requiredAction`
- `conflictingRevision`

#### Protocol conformance suite

Test initialization negotiation, notification handling, malformed batches, cancellation, large
payloads, reconnect behavior, and resource-list stability.

#### Production connection diagnostics

Add a read-only `system_connection_status` tool and an operator-facing setup test. It should verify:

- HTTPS and authentication.
- Protocol negotiation.
- Agent identity binding.
- `tools/list`, `resources/list`, and one bounded resource read.
- Server version, capability version, and clock.

It must not create a handoff merely to prove the connection works.

#### Scoped agent credential management

Add an agent registry and independently revocable, expiring credentials. Bind the effective agent
identity server-side so a client cannot change identity by changing `x-agent-label` while reusing the
same credential.

### Priority 1 — Make Codex immediately useful

#### `hcc://workspace/context` resource

Return a compact operator-oriented snapshot:

- Current version.
- Active clients and projects.
- Overdue and blocked tasks.
- Active handoffs.
- Queue health.
- Relevant project constraints.
- Available MCP capabilities.

Support filters and a response-size ceiling.

#### Read-only workspace tools

Start with the five-read rollout already proposed in the decision record:

- `workspace_dashboard_summary`
- `workspace_list_tasks`
- `signal_list_posts`
- `signal_queue_snapshot`
- `signal_publish_preview`

Read tools provide substantial value with low operational risk.

#### Purpose-built lookup tools

Add `workspace_search` and `workspace_get_subject_context`, accepting a task, project, client, or
Signal identifier and returning one bounded context package. Agents perform better with one relevant
result than several large list responses.

#### MCP prompts

Provide discoverable prompts such as:

- `start_claimed_work`
- `review_project_status`
- `prepare_handoff`
- `verify_before_complete`
- `triage_signal_queue`

These should encode project-specific rules without bloating every tool description.

#### Companion Codex skill or plugin

Package the MCP connection plus a focused Hybrid Command Center skill. It should teach Codex when to
inspect, claim, checkpoint, validate, complete, or stop for operator approval. This aligns with
OpenAI's current skill-plus-MCP plugin model. [OpenAI's Codex use
cases](https://learn.chatgpt.com/use-cases) explicitly include durable goals, project teammates,
documentation maintenance, workflow audits, and composable agent-facing CLIs.

#### Guided cloud connection setup

Provide a copy-ready Codex connection flow for the production origin:

1. Register or select an agent identity in HCC.
2. Issue a scoped credential once.
3. Generate the correct MCP configuration for that identity.
4. Run the read-only connection diagnostic.
5. Show the agent's last successful connection in HCC.

This removes the current need to translate browser login, bearer issuance, endpoint URL, and agent
label requirements manually.

### Priority 2 — Robust agent work sessions

Introduce a separate `agent_work_sessions` concept rather than turning handoffs into a workflow
engine.

Suggested lifecycle:

```text
PLANNED → CLAIMED → IN_PROGRESS → NEEDS_INPUT | BLOCKED | COMPLETED | ABANDONED
```

Capabilities:

- `work_start`
- `work_heartbeat`
- `work_checkpoint`
- `work_request_input`
- `work_mark_blocked`
- `work_release`
- `work_complete`
- `work_get_resume_context`

A work session should record:

- Handoff and subject.
- Agent label.
- Lease expiry.
- Base revision.
- Branch or worktree when applicable.
- Current step.
- Structured evidence.
- Validation results.
- Final artifact, commit, issue, or pull-request references.

Keep this separate from the existing handoff record: a handoff is a request; a work session is an
execution attempt.

### Priority 3 — Safe workspace mutation

After the read surface and concurrency controls are stable, add:

- Create or update task.
- Manage checklist and dependencies.
- Create or update project.
- Create or update Signal draft.
- Set a Signal slot.
- Update variants and targets.
- Duplicate a Signal post.
- Acknowledge queue alerts.

Every mutation should include:

- Idempotency key.
- Expected revision.
- Dry-run or preview when the change is compound.
- Explicit confirmation token for destructive actions.
- Structured before/after summary.
- Audit event.

Continue excluding provider publishing, Drive modification, permanent deletion, and other external
or irreversible operations unless they retain the existing human-confirmed workflow.

### Priority 4 — Event-driven coordination

Replace rapid polling with resumable change feeds:

- `hcc://coordination/changes?after=<cursor>`
- `hcc://workspace/changes?after=<cursor>`
- Resource update notifications where client support allows.
- Monotonic cursors.
- Replay after reconnect.
- Bounded retention with a clear "cursor expired; reload snapshot" result.

This would let Codex watch for directed work without repeatedly retrieving the entire inbox.

For the hosted instance, cursor-based replay is preferable to relying only on a long-lived socket:
agents will sleep, laptops will disconnect, credentials will rotate, and deployments will restart the
Node process. A reconnecting agent must be able to ask what changed after its last durable cursor.

### Priority 5 — Verification and evaluation

Build a representative Codex evaluation suite covering:

- Discovering the correct task.
- Avoiding already-claimed work.
- Recovering after a lost response.
- Rejecting a stale revision.
- Resuming from a checkpoint.
- Reporting validation evidence.
- Respecting the publish and Drive approval boundary.
- Avoiding duplicate mutations after retries.
- Handling an expired claim.
- Producing a useful operator handoff.
- Connecting from two independent remote agent identities.
- Proving one credential cannot impersonate the other agent by changing a header.
- Revoking one agent without interrupting other connected agents.
- Recovering its change cursor after a server restart.

Current OpenAI guidance recommends benchmarking tool workflows on task success, evidence
completeness, latency, token use, and cost—not merely call count. It also identifies Programmatic
Tool Calling as useful for bounded filtering, joining, validation, and aggregation stages, while
approval-bearing actions should remain direct model decisions. See [official model
guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Suggested delivery sequence

1. Fix HTTP limiter identity and add the missing multi-request network test.
2. Add scoped agent identities, credential rotation/revocation, and server-bound labels.
3. Add production MCP diagnostics and operator-visible health telemetry.
4. Reconcile the MCP and cloud documents with the live production origin.
5. Add capability/version and compact workspace-context resources.
6. Ship the five read-only workspace and Signal tools.
7. Add structured completion evidence and idempotency to every coordination mutation.
8. Introduce leased work sessions and resumable checkpoints.
9. Add carefully bounded workspace writes.
10. Add cursor-based change feeds and reconnect replay.
11. Package the connection and operating workflow as a Codex skill or plugin.
12. Expand only after evaluations demonstrate reliable behavior against a non-production fixture and
    a bounded production read-only smoke test.

## Bottom line

The deployment successfully removes the workstation boundary: HCC can now become the shared control
plane for Codex agents wherever they run. The security and domain boundaries are good. The weak point
is not the handoff state machine; it is the space between "Codex connected to production" and
"Codex has a scoped identity and can safely understand, execute, resume, and prove useful work."

The recommended target architecture is:

> **Cloud MCP server for authoritative operations + scoped agent identities + compact resources for
> context + a Codex skill for workflow policy + structured work sessions for resumability and
> evidence + operator-visible health and revocation.**

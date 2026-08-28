# Claude Code MCP Agent Capabilities Report

**Reviewed:** 27 August 2026
**Repository:** `GHolmesDesigns/hybrid-command-center`
**Reviewed version:** 5.4.2 (local `main` at `8617968`)
**Production origin:** `https://hcc.gholmesdesigns.com`
**Local agent label:** `claude-review` ([`.mcp.json`](../.mcp.json))

Related: [`docs/codex-mcp-capabilities-report.md`](codex-mcp-capabilities-report.md),
[`docs/cursor-mcp-agent-capabilities-report.md`](cursor-mcp-agent-capabilities-report.md),
[`docs/multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md),
[`docs/agent-coordination-plan.md`](agent-coordination-plan.md).

## Confirmed bug — HTTP write rate limiter does not persist across requests

**Status:** Open. **Priority:** 0. **Confirmed live against production**, not just by source
review.

- **Where:** [`server/mcp/http.ts:121`](../server/mcp/http.ts) — `handleMcpHttpPost` constructs
  `const session = createMcpSession()` fresh on every `POST /api/mcp`. The rolling-window write
  limiter ([`server/mcp/session.ts`](../server/mcp/session.ts),
  [`server/mcp/rate-limit.ts`](../server/mcp/rate-limit.ts)) lives inside that per-request object,
  so its counter never accumulates across separate HTTP calls.
- **Impact:** the documented budget of **10 coordination writes per rolling minute per MCP
  session** ([`docs/agent-coordination-plan.md`](agent-coordination-plan.md) §5.6, threat H2) is
  enforced for long-lived stdio sessions but is a no-op over the network transport — any client
  issuing one tool call per HTTP request (which is how this transport works; there is no
  persistent connection) gets an unbounded write rate.
- **Reproduced this session:** 11 consecutive `coordination_claim_handoff` calls against a
  nonexistent handoff ID, sent to `https://hcc.gholmesdesigns.com/api/mcp` with one bearer and one
  `x-agent-label`. All 11 returned `FAILURE / Handoff not found`; none returned
  `REFUSED / rate limit exceeded`, which should have appeared on or before the 11th call if the
  budget were enforced.
- **Fix direction:** key the limiter by bearer/session identity plus `agent_label` in a
  server-side store (bounded, TTL-pruned) instead of per-request session state; add an
  eleven-request HTTP integration test so a regression can't silently reopen this.
- **Independently corroborated** by both sibling reports —
  [`docs/codex-mcp-capabilities-report.md`](codex-mcp-capabilities-report.md) §"Principal
  findings" #1 and
  [`docs/cursor-mcp-agent-capabilities-report.md`](cursor-mcp-agent-capabilities-report.md)
  §"Principal gaps" #1 — from source review alone; this session is the one that reproduced it
  live.

## What changed since the pre-deployment review

The prior version of this review (chat-only, no file) assessed the MCP surface from source and
the local stdio session alone. Two things are now different:

1. **The app is live at a public HTTPS origin**, independently verified this session:
   - `GET https://hcc.gholmesdesigns.com/` → 200, serves the client, and renders the operator
     password gate before any workspace data.
   - `POST https://hcc.gholmesdesigns.com/api/mcp` with **no auth** → **401
     `{"error":"Authentication required."}"`**. Network MCP fails closed on production exactly as
     [`server/mcp/http.ts`](../server/mcp/http.ts) and the 5.4.1 regression test claim. No
     credentials were entered or requested for this check.
2. **A live three-agent coordination test already ran on this workstation** — `coordination_list_handoffs`
   (called live during this review) shows a completed connectivity chain
   `cursor-planning → codex-release` and `claude-desktop → cursor-planning`, plus an **open**
   handoff from `claude-desktop`: a Week 5 Signal import that failed once as pasted text
   (multi-line captions broken by the line-based importer — matches
   [`docs/signal-import-format.md`](signal-import-format.md)) and was retried as an `.xlsx`
   workbook.

**Update — the network path has now been tested for real**, in this session, with a scoped
bearer minted through the live login flow (no password entered by the agent; the operator signed
in, the agent minted and used the bearer, then revoked it via logout). Two confirmed results:

1. **`POST https://hcc.gholmesdesigns.com/api/mcp` with a real bearer returned the exact same
   handoff rows** — identical UUIDs, identical millisecond timestamps — as the local stdio session
   read earlier in this review. **Confirmed by the operator: this was a one-time database seed
   performed during today's cutover, not an ongoing sync.** `DATABASE_PATH` is a plain local path
   with no replication code, and `hcc.gholmesdesigns.com` resolves to a genuine separate AWS host
   (`35.172.82.47`) — the match was explained by `.fuse_hidden*` artifacts appearing in local
   `data/` ~51 minutes before the connectivity test began, consistent with a backup restored
   locally and then that same database deployed to production as its cutover seed.
   [`docs/cloud-hosting.md`](cloud-hosting.md) §2's "separate installs, not a synced replica" claim
   holds going forward — today's identical data was a one-time seeding event, not a standing
   mechanism. Local and production will diverge normally from here on new writes; **local testing
   is not a proxy for production behavior beyond today.**
2. **The HTTP rate-limiter bug is confirmed live, not just by source review.** Eleven consecutive
   `coordination_claim_handoff` calls against a nonexistent handoff ID, sent with the same bearer
   and agent label, all returned `FAILURE / Handoff not found` — none returned the
   `REFUSED / rate limit exceeded` message that should appear once the stated 10/minute budget is
   exceeded. The fresh-`McpSession`-per-POST bug in [`server/mcp/http.ts:121`](../server/mcp/http.ts)
   is not theoretical on this deployment; it was reproduced against the public origin.

Bearer hygiene: the test bearer was minted via `POST /api/auth/mcp-bearer` against the operator's
live session, used for the calls above, then invalidated by logging out that session (there is no
standalone single-bearer revoke endpoint — only logout, password change, or restore revoke
bearers). A follow-up `tools/list` call with the same token returned `401` after logout, confirming
revocation worked.

## Does production surface genuinely new capabilities?

Yes — three, none of which existed as anything but architecture-doc hypotheticals before cutover:

- **Cross-device coordination becomes real, not theoretical.** Local stdio only ever coordinated
  agents on one workstation sharing one SQLite file. A live origin with revocable bearers means a
  Claude Code session on a different machine can join the same handoff queue as `claude-desktop`,
  `cursor-planning`, and `codex-release` did here — today, without further code changes.
- **The network transport is now an attack surface, not a design doc.** The HTTP session-per-request
  rate-limiter bug (flagged in the pre-deployment review, and independently confirmed by both the
  Codex and Cursor reports) is no longer a workstation-only concern — it is a live gap on a public
  origin. This moves from "should fix" to "should fix before advertising the network endpoint to
  any agent that isn't you."
- **Operational continuity (EBS, S3, systemd, health checks) makes durable agent state a realistic
  product feature**, not just a database column. Claim leases, work-session checkpoints, and
  resumable coordination only pay off if the workspace they resume against actually survives
  restarts — production now guarantees that; the local dev install never did.

Everything else in the Codex and Cursor reports' gap analysis (coordination-only tool surface,
self-declared completion, no claim leases, discovery friction, scoped identity) was already true
pre-deployment and remains true post-deployment — deployment raises the stakes on those items, it
doesn't introduce them. I won't re-derive that analysis; both sibling reports cover it in more
detail than is useful to repeat here, and this session's live checks corroborate their findings.

## Claude-Code-specific angle

This is the piece the Codex and Cursor reports don't cover, because it's specific to this
platform: Claude Code already has its own multi-agent primitives that are a natural fit for HCC's
coordination hub, once the identity and rate-limit gaps above are closed.

- **`Workflow`/`Agent` tools could poll `hcc://coordination/inbox` directly.** A scheduled Claude
  Code loop (`ScheduleWakeup`, or a cron-triggered session) could watch for `OPEN` handoffs directed
  at `claude-review` or `claude-code`, spawn a subagent per handoff via the `Agent` tool, and post
  completion notes back through `coordination_complete_handoff` — turning the currently-manual
  claim → work → complete loop into a background process, without HCC needing to build its own
  scheduler.
- **`SendMessage`/`ListAgents` are a second coordination channel that already exists in this
  runtime.** Nothing here should replace HCC's `agent_handoffs` (which is durable, cross-platform,
  and outlives any one Claude Code session), but a Claude Code-side skill could bridge the two: a
  handoff claimed via MCP could spawn a named subagent session so its progress is visible in
  `ListAgents`, giving the operator two views (HCC inbox, Claude Code session list) of the same
  work without double-tracking state.
- **A packaged skill, not just an `.mcp.json` entry**, matches how this session actually consumes
  MCP servers (`Skill` tool, `SuggestSkills`, project-scoped skills). A `hybrid-command-center`
  skill that encodes the claim → work → prove workflow (mirroring the Cursor report's proposed
  skill) would show up in this session's available-skills listing the same way `code-review` or
  `loop` do today, rather than relying on the model already knowing HCC's conventions from a doc
  read.

None of this requires new HCC server code beyond what Priority 0/1 below already call for — it's
a client-side integration opportunity that becomes worth building once the tool surface has more
than seven handoff-only tools to act on.

## Revised priorities

Both sibling reports independently converge on the same Priority 0/1 list from source analysis
alone; production deployment and the live checks in this review confirm rather than change the
ordering. Consolidated:

| # | Item | Why production changes the urgency |
| --- | --- | --- |
| 0 | **Fix the HTTP per-request rate-limiter** ([server/mcp/http.ts:121](../server/mcp/http.ts)) | **Confirmed live**, not just by source review: 11 consecutive write calls against production with one bearer never hit the rate limit. Add the missing eleven-request integration test alongside the fix. |
| 1 | **Ship the five read-only workspace/Signal tools** (`workspace_dashboard_summary`, `workspace_list_tasks`, `signal_list_posts`, `signal_queue_health`, `signal_publish_preview`) | The open Week 5 handoff is exactly the class of work this would remove a manual step from — an agent could inspect the failed import via MCP instead of relying on the handoff message body as the only record. |
| 1 | **Scoped, revocable agent identity** (registry + capability scopes, not just operator-bound bearers) | Cross-device coordination is real now; "one bearer per operator session" doesn't distinguish `claude-review` on this workstation from a Claude Code session on another machine. |
| 2 | **Evidence-backed `coordination_complete_handoff`** | Directly visible in the live data above: `claude-desktop`'s two Week 5 handoffs record a message but no structured result, so "completed" and "diagnosed, superseded" are indistinguishable without reading prose. |
| 2 | **Claim leases / work sessions** | Same rationale as both sibling reports — orthogonal to deployment, still correct. |

## Bottom line

Deployment didn't change what's broken; it changed what's at stake — and testing the live path
directly turned up one thing source review alone couldn't. The coordination layer's auth boundary
is sound (verified live: unauthenticated calls fail closed with 401, a revoked bearer fails closed
with 401). Its rate limiter is not (verified live: 11/11 write calls against production skipped the
stated budget) — that bug is no longer a source-review hypothesis, it's reproduced against
`hcc.gholmesdesigns.com` with a real, since-revoked credential, and should be Priority 0 before the
network endpoint is handed to any agent beyond today's one-time cutover seed. The gap between
"agents can message each other about work" and "agents can see and safely do the work" is unchanged
from the pre-deployment assessment. One process note for future reviews: today's identical
local/production data was a one-time seed, confirmed by the operator — it is not standing behavior,
and the next capability report against this deployment should expect local and production to have
diverged.

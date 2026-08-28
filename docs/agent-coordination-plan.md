# Agent Coordination Hub — Plan

Status: **decided (C109 / #336), not implemented.** This plan extends the MCP work from
[`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) (C105) with a coordination layer so
multiple IDE agents can **hand work to each other through HCC** rather than relying on accidental
reads of the same SQLite rows.

**Decision date:** 25 August 2026. Card C109 finalizes §4–§8 below. Runtime, schema, UI, and MCP
tools ship in C110–C112; this document adds no application code.

Card C105 settled the **shared workspace hub** — every platform reads and writes one source of
truth. This plan settles the **coordination hub** — platforms leave structured messages, claims,
and completion records the others can act on.

Nothing here reopens C105's transport choice, provider MCP consumption, or provider-write policy.
Provider publishing remains human-confirmed in the UI unless a later explicit security decision
changes it. Completing a handoff never calls publish, Drive, or import paths.

---

## 1. What “hub” means here

| Layer | What it provides | Cards |
| --- | --- | --- |
| Shared workspace | One SQLite truth for clients, tasks, Signal | MCP-C106–MCP-C108 (Wave 22) |
| **Agent coordination** | Handoffs, claims, threads, operator inbox | **C109–C112** |
| Remote access | Network MCP on the hosted origin | C113 |

**In scope:** durable handoffs between named agents (`agent_label` from MCP init), an operator-visible
inbox, and MCP tools to post, claim, complete, and list coordination items.

**Out of scope:** real-time chat, push notifications, autonomous publish chains, multi-user tenancy,
GitHub/PR orchestration (still deferred as a separate product from C105 §1.6), and consuming
provider MCP servers.

---

## 2. Dependency graph

```
C105 (decided, #304)
  └─ MCP-C106 stdio read
       └─ MCP-C107 local write
            └─ MCP-C108 integration write
                 ├─ C109 coordination decision (docs, #336)
                 │    └─ C110 handoff domain + schema (#337)
                 │         ├─ C111 coordination MCP tools (#338)
                 │         └─ C112 operator coordination UI (#339)
                 └─ C113 network MCP (#340, after C51)
```

C110–C112 may ship on local stdio before C113. Coordination does not require network access.

### Waves, milestones, and end-to-end coverage

These waves continue the repository sequence from Wave 19 (C103). **Wave 20 (#305–#307 provider
lifecycle) and Wave 21 (trust decisions) already exist** — MCP work starts at Wave 22. These rows
are dependency groups; at filing time each wave becomes one GitHub milestone unless split only to
satisfy the one-`e2e`-spec-per-milestone rule in `AGENTS.md`.

Sizes are the repository label scale, not calendar days: `size-s` under 1 hour, `size-m` 1–3 hours,
`size-l` 4–8 hours, `size-xl` 8–12 hours, `size-xxl` a day or more.

| Wave | Cards | GitHub issues | Theme | Estimate (sequential) | Browser coverage |
| --- | --- | --- | --- | --- | --- |
| 22 — Multi-agent MCP | C105, MCP-C106, MCP-C107, MCP-C108 | #304, TBD | Workspace read/write over local stdio | **~10–22 h** (1–3 h + 1–3 h + 4–8 h + 4–8 h) | `e2e/mcp-signal-planning.spec.ts` on MCP-C107 |
| 23 — Agent coordination hub | C109, C110, C111, C112 | #336–#339 | Handoffs, claims, operator inbox | **~7–17 h** (1–3 h + 4–8 h + 1–3 h + 1–3 h) | `e2e/coordination-inbox.spec.ts` on C112 |
| 24 — Network MCP | C113 | #340 | Streamable HTTP MCP after operator auth | **4–8 h** | integration tests only; staging rehearsal per C55 |

**MCP-C106–C108** are the implementation cards named in
[`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) §10. They are **not** publishing-wave
C106–C108 (#305–#307).

Wave 22 must land before Wave 23 starts **implementation** work (C110+). C109 (this docs
settlement) binds to MCP-C106's `agent_label` and `mcp_agent_events` **contracts** from
[`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) and does not require that runtime to
exist before the decision merges. Wave 24 stays **deferred** until C51 (#177), C53 (#179), and C55
(#181) merge; it may share the Cloud Hosting milestone rather than ship as a code-only Wave 24.

### Card index (coordination and network)

| Card | Type | Size | Estimate | Wave | Issue | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| C109 | `docs` | M | 1–3 h | 23 | #336 | C105 (#304); MCP-C106 contracts |
| C110 | `feat` | L | 4–8 h | 23 | #337 | C109, MCP-C107 |
| C111 | `feat` | M | 1–3 h | 23 | #338 | C110, MCP-C108 |
| C112 | `feat` | M | 1–3 h | 23 | #339 | C110 |
| C113 | `feat` | L | 4–8 h | 24 | #340 | MCP-C108, C111, C51–C55 |

---

## 3. Cards

### C109 — Decide the agent coordination hub model (shipped)

**Type / branch:** `docs/336-agent-coordination-decision`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 23 — Agent coordination hub · **Labels:** `enhancement` `tier-1-security` `docs`
**Issue:** #336
**Depends on:** C105 (#304). Binds to MCP-C106's `agent_label` and `mcp_agent_events` contracts as
named in [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md); does not wait on MCP runtime
code for this docs settlement.
**Blocks:** C110, C111, C112.

#### Problem

C105 lets multiple agents share one workspace, but coordination is accidental: last-write-wins on
rows, no handoff, no “waiting on Claude”, no claim lease, and no operator view of what one agent
asked another to do. That is a **data hub**, not a **communication hub**.

Building handoff tables or MCP tools before choosing the coordination vocabulary would either bake
in chat semantics this product does not want, or recreate GitHub issues inside SQLite without saying
so.

#### Scope

Produce a dated decision amendment (this document's §4–§8) that settles:

- coordination **primitives** (handoff, note, broadcast) and which ship in v1;
- **identity**: `agent_label` as the sole agent principal in v1; operator as override;
- **authorization**: who may post, claim, complete, or cancel a handoff;
- **lifecycle** states and timeouts;
- **idempotency** and duplicate-handoff rules;
- **rate limits** and bounded message bodies;
- **audit** rows alongside `mcp_agent_events`;
- **threat model** for spam, claim theft, and secret leakage in messages;
- explicit **rejection** of autonomous provider publish via handoff completion;
- bounded implementation cards C110–C112 that do not reopen C105 trust boundaries.

#### Out of scope

- Runtime, schema, UI, or MCP tool implementation in this card.
- GitHub / branch / PR coordination.
- Network MCP (C113).
- Provider-write automation.

#### Acceptance criteria

- [x] Handoff is chosen as the v1 primitive; chat and broadcast are rejected or deferred with reasons.
- [x] Every coordination action has an owner module, authorization rule, and audit rule.
- [x] Claim semantics are defined for directed handoffs vs open-pool handoffs.
- [x] Provider publishing cannot be triggered by completing a handoff.
- [x] C110–C112 can be implemented without reopening C105 transport or provider-write policy.
- [x] Threat-model checklist (§8) is included.

#### Verification

Documentation review, `npm run format:check`, `git diff --check`. No runtime change.

---

### C110 — Agent handoff queue (domain and schema)

**Type / branch:** `feat/<issue>-agent-handoff-queue`
**Size:** L · **Estimate:** 4–8 hours · **Wave / milestone:** 23 — Agent coordination hub · **Labels:** `enhancement` `size-l` `tier-3-schema`
**Issue:** #337
**Depends on:** C109, C107 (`agent_label` on MCP writes).
**Blocks:** C111, C112.

#### Problem

Agents need a durable record that survives MCP session restarts: “Cursor drafted caption; Claude
should review”, with a claim so two agents do not duplicate work, and completion so the operator can
see the chain.

#### Settled behaviour

- Add **`agent_handoffs`** (name fixed in C109 amendment) with append-friendly lifecycle:
  `OPEN` → `CLAIMED` → `COMPLETED` | `CANCELLED`.
- A handoff carries: `id`, `created_at`, `updated_at`, `from_agent_label`, optional
  `to_agent_label` (null = open pool), `subject_type`, optional `subject_id`, bounded `message`,
  `state`, optional `claimed_by`, `claimed_at`, optional `completed_at`, optional `cancelled_at`,
  `cancel_reason` (operator or agent).
- **`subject_type`** enum v1: `task`, `signal_post`, `project`, `client`, `freeform`. Binds the
  handoff to workspace entities when present; `freeform` for general requests.
- **Directed handoff** (`to_agent_label` set): only that label may claim; others receive `REFUSED`.
- **Open pool** (`to_agent_label` null): first claim wins; claim is atomic in one transaction.
- **Operator override**: HTTP routes (not MCP v1) may cancel any handoff; UI card C112.
- **Notes** are separate rows in **`agent_handoff_notes`** — comments on a handoff without changing
  its state. Append-only, bounded body, `agent_label`, `at`.
- **No secrets** in message or note bodies — validated length, passed through `redactSecrets` on
  write; URLs allowed, credentials refused by pattern.
- **TTL**: `OPEN` handoffs older than **30 days** surface a queue-health-style **stale handoff**
  warning in C112; they are not auto-deleted in v1.
- **Idempotency**: `postHandoff` accepts optional `client_request_id` (max 64 chars); duplicate
  `(from_agent_label, client_request_id)` returns the existing row instead of creating a second.
- Domain logic lives in **`server/domain/agent-coordination.ts`** — framework-free rules, unit-tested.
- Service persistence in **`server/agent-coordination/service.ts`** — transactional writes only.
- **Does not** mutate `tasks`, `signal_posts`, or any workspace row on claim/complete — coordination
  is metadata beside the workspace, not a substitute for edits.

#### Out of scope

- MCP tools (C111).
- UI (C112).
- Push, email, or webhooks.
- Auto-assign / ML routing.
- Completing a handoff triggering publish, Drive sync, or import.

#### Acceptance criteria

- [ ] Schema migrates additively; indexes on `(state, created_at)` and `(to_agent_label, state)`.
- [ ] Directed vs open-pool claim rules covered by unit tests.
- [ ] Duplicate `client_request_id` returns existing handoff without second insert.
- [ ] Claim, complete, cancel, and add-note are each one transaction.
- [ ] Operator cancel via HTTP succeeds on any state except already `COMPLETED`.
- [ ] Message/note length limits enforced at Zod boundary and SQLite trigger/check.
- [ ] No integration_events row — coordination is local metadata; audit via handoff row + notes.

#### Verification

`npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build`, `npm run db:migrate`.

---

### C111 — Coordination MCP tools

**Type / branch:** `feat/<issue>-mcp-coordination-tools`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 23 — Agent coordination hub · **Labels:** `enhancement` `size-m`
**Issue:** #338
**Depends on:** C110, C108.
**Blocks:** none (C112 may parallel after C110).

#### Problem

Agents on Cursor, Claude Code, and other MCP clients need to use the handoff queue without the
browser. Tools must map to C110 services and inherit C105 rate limits.

#### Scope

Add MCP tools (stdio; automatically on C113 network surface when that lands):

| Tool | Class | Authorization | Audit |
| --- | --- | --- | --- |
| `coordination_list_handoffs` | R | Operator | — |
| `coordination_get_handoff` | R | Operator | — |
| `coordination_post_handoff` | L | Operator; `from_agent_label` must match MCP init label | `mcp_agent_events` + handoff row |
| `coordination_claim_handoff` | L | Operator; label must match directed target or any for open pool | `mcp_agent_events` |
| `coordination_complete_handoff` | L | Operator; only `claimed_by` or operator | `mcp_agent_events` |
| `coordination_cancel_handoff` | L | Operator; poster, claimer, or operator | `mcp_agent_events` |
| `coordination_add_note` | L | Operator | `mcp_agent_events` + note row |

Add MCP resource:

| Resource | Purpose |
| --- | --- |
| `hcc://coordination/inbox?state=open` | Snapshot of open/claimed handoffs for subscribing agents |

**Rate limits:** at most **10 coordination writes per rolling minute** per MCP session (post, claim,
complete, cancel, note combined).

**Required init:** MCP client must supply non-empty `agent_label` in initialization metadata for
coordination tools; otherwise tools return `REFUSED` with a clear error (read tools still work).

#### Out of scope

- Provider publish on complete.
- Subscribing / streaming / WebSocket push (agents poll list or resource).
- Cross-workspace federation.

#### Acceptance criteria

- [ ] Each tool maps to exactly one service method; no duplicate domain rules in MCP layer.
- [ ] Directed claim refusal and open-pool first-claim success covered by integration tests.
- [ ] Missing `agent_label` refuses coordination writes, allows reads.
- [ ] Rate limit refuses excess writes with `REFUSED` logged to `mcp_agent_events`.
- [ ] `coordination_post_handoff` honours `client_request_id` idempotency.
- [ ] Tool results never include secrets; redaction tested.

#### Verification

`npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run build`.

---

### C112 — Operator coordination inbox (UI)

**Type / branch:** `feat/<issue>-coordination-inbox-ui`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 23 — Agent coordination hub · **Labels:** `enhancement` `size-m`
**Issue:** #339 · **Browser coverage:** `e2e/coordination-inbox.spec.ts`
**Depends on:** C110.
**Blocks:** none.

#### Problem

The operator needs to see what agents asked each other to do, cancel stuck handoffs, and understand
blockers without opening every MCP session log.

#### Scope

- New **Agent handoffs** panel reachable from Settings or Dashboard (exact nav chosen in card; one
  entry point, linked in USER_MANUAL in the same PR).
- Lists handoffs grouped by state: **Open**, **Claimed**, **Completed (7d)**, **Cancelled (7d)**.
- Each row shows: from → to (or “any agent”), subject link when bound, message excerpt, claimer,
  timestamps.
- Operator actions: **Cancel** with reason (required text), view notes thread.
- Read-only for completed rows; no edit of message body after post.
- Accessible: keyboard focus, state labels not colour-only, responsive layout.
- API routes under `/api/coordination/*` using the same service as MCP; session auth when C51
  exists, loopback-trusted until then (same as rest of API).

#### Out of scope

- Posting handoffs from UI in v1 (agents post via MCP; operator cancels only).
- Real-time live updates (manual refresh or navigation reload).
- Mobile-specific app; responsive web only.

#### Acceptance criteria

- [ ] Operator can list, open, and cancel handoffs created via service layer tests / MCP.
- [ ] Subject links resolve to task, Signal post, project, or client when `subject_id` present.
- [ ] Cancel requires reason; writes `cancel_reason` and `CANCELLED` atomically.
- [ ] Empty states for each group; error state on load failure.
- [ ] `e2e/coordination-inbox.spec.ts`: seed handoffs via API, view in UI, cancel one.

#### Verification

`npm run test:e2e`, `npm run test:coverage`, all required quality gates.

---

### C113 — Network MCP behind operator auth

**Type / branch:** `feat/<issue>-mcp-network`
**Size:** L · **Estimate:** 4–8 hours · **Wave / milestone:** 24 — Network MCP (deferred; may join Cloud Hosting) · **Labels:** `enhancement` `size-l` `tier-1-security` `blocked` `deferred`
**Issue:** #340
**Depends on:** C108, C111 (coordination tools included in network surface), C51 (#177), C53
(#179), C55 (#181).
**Blocks:** none.

#### Problem

Local stdio limits agents to the workstation that holds SQLite. A hosted operator wants the same MCP
tool surface — workspace, Signal, and coordination — from agents on other devices.

#### Settled behaviour

- Streamable HTTP MCP on the **same HTTPS origin** as the API (no second port).
- Every request requires C51 operator session **or** a server-issued MCP bearer bound to that
  session, plus CSRF on mutations, plus required `agent_label` header for coordination writes.
- Tool surface is **identical** to stdio: §9 of `multi-agent-mcp-decision.md` plus C111 coordination
  tools. No additional network-only powers.
- Provider-write tools remain excluded.
- Rate limits from C105 and C111 apply per session/bearer.
- Bearer revoked on logout, password change, restore (C51, C55).

#### Out of scope

- Provider-write tools.
- Public unauthenticated MCP.
- MCP on a separate origin or port.

#### Acceptance criteria

- [ ] Unauthenticated and missing-CSRF requests fail closed.
- [ ] Coordination and workspace tools behave identically to stdio in integration tests.
- [ ] Bearer revocation tested on logout and password change.
- [ ] No secret in MCP responses; proxy trust matches C53 contract.

#### Verification

Integration tests with mock auth; staging rehearsal against disposable infra per C55 checklist;
all required quality gates. No production launch in the PR.

---

## 4. Coordination primitives (C109 settlement)

**The decision:** v1 ships a **claimable handoff** with optional **notes**. Everything else is
deferred or rejected. The product is a structured work queue beside the workspace — not chat, not
GitHub Issues in SQLite, and not an autonomous workflow engine.

| Primitive | v1 verdict | Reason |
| --- | --- | --- |
| **Handoff** | **Ship** | Structured “please do X on Y”; claimable; completes with an audit trail |
| **Note** | **Ship** | Thread on a handoff without changing its state |
| **Broadcast** | **Defer** | Operator announcements without a subject duplicate dashboard noise; revisit if the inbox proves insufficient |
| **Chat / DM** | **Reject** | Unbounded conversation belongs in IDE threads, not SQLite |
| **Workflow engine** | **Defer** | Multi-step DAGs (A→B→C mandatory) need a second decision; v1 is a single hop |

### 4.1 Table and field names (fixed)

| Name | Role |
| --- | --- |
| `agent_handoffs` | One row per handoff; state machine lives here |
| `agent_handoff_notes` | Append-only comments on a handoff; never change handoff state |

A handoff carries: `id`, `created_at`, `updated_at`, `from_agent_label`, optional `to_agent_label`
(null = open pool), `subject_type`, optional `subject_id`, bounded `message`, `state`, optional
`claimed_by`, `claimed_at`, optional `completed_at`, optional `cancelled_at`, `cancel_reason`,
optional `client_request_id`.

**`subject_type` enum (v1):** `task`, `signal_post`, `project`, `client`, `freeform`. When
`subject_id` is set, the handoff binds to that workspace row; `freeform` is for requests with no
entity. Binding is a pointer for the inbox UI — claim and complete **never** mutate the subject.

### 4.2 Bounds

| Field | Limit |
| --- | --- |
| `message` | 2000 Unicode characters |
| Note body | 2000 Unicode characters |
| `agent_label` / `from_agent_label` / `to_agent_label` / `claimed_by` | Non-empty, trimmed, max 64 chars; charset and init validation are MCP-C106's to ship and C110 reuses |
| `client_request_id` | Max 64 chars; optional |
| `cancel_reason` | Required on cancel; 1–500 Unicode characters |

Bodies pass through `redactSecrets` on write. Credential-shaped substrings are refused or scrubbed
at the Zod boundary before insert; URLs without credentials remain allowed.

### 4.3 Explicit non-goals tied to primitives

- Completing a handoff **must not** invoke `server/publish/*`, Drive write paths, playbook import
  commit, or any provider adapter.
- A handoff is **not** a second schedule: Signal dates and times stay in `signal_posts` only.
- Agents still edit workspace rows through ordinary MCP workspace/Signal tools (C105 surface). The
  handoff only records who was asked to do that work and whether they finished.

---

## 5. Identity, lifecycle, claims, and timeouts

### 5.1 Identity

| Principal | Role in v1 |
| --- | --- |
| **Operator** | Workspace owner. May cancel any handoff over HTTP (C112). Implicit on loopback until C51; session-bound afterward. |
| **`agent_label`** | **Sole agent principal for coordination.** Supplied at MCP init (contract from MCP-C106). Required for coordination **writes**; optional/forensic for ordinary workspace tools per C105 §4.1. |

This does **not** reopen C105: for workspace and Signal tools, `agent_label` remains forensic. For
coordination claim/complete/cancel among agents, the label is the authorization principal so a
directed handoff means something. Agents are still not tenants — one operator workspace.

### 5.2 Lifecycle

```
                    ┌─────────────┐
         post       │    OPEN     │◄─── open pool or directed
        ──────────► │             │
                    └──────┬──────┘
                           │ claim (atomic)
                           ▼
                    ┌─────────────┐
                    │   CLAIMED   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              complete     │      cancel (poster, claimer, operator)
              ▼            ▼            ▼
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │COMPLETED │  │CANCELLED │  │CANCELLED │
       └──────────┘  └──────────┘  └──────────┘
```

| Transition | From | Rule |
| --- | --- | --- |
| Post | — → `OPEN` | Creates the row; does not claim |
| Claim | `OPEN` → `CLAIMED` | Atomic; sets `claimed_by` / `claimed_at` |
| Complete | `CLAIMED` → `COMPLETED` | Only `claimed_by` (MCP) or refused |
| Cancel | `OPEN` or `CLAIMED` → `CANCELLED` | Poster, claimer, or operator; requires `cancel_reason` |
| Re-open | any → `OPEN` | **Declined** — post a new handoff |

Terminal states (`COMPLETED`, `CANCELLED`) are immutable except for append-only notes on
`COMPLETED` (notes on `CANCELLED` are refused).

### 5.3 Claim semantics

| Kind | `to_agent_label` | Who may claim | Conflict |
| --- | --- | --- | --- |
| **Directed** | Non-null | Only the matching label | Any other label receives `REFUSED` |
| **Open pool** | Null | Any non-empty label | First successful claim wins; second concurrent claim in the same transaction sees `CLAIMED` and receives `REFUSED` |

Claim is one SQLite transaction that reads state, checks authorization, and updates — never
read-then-write across separate statements at the service boundary. There is no soft lease or
heartbeat in v1: a stuck `CLAIMED` handoff is cancelled by the operator or the claimer, not expired
automatically.

### 5.4 Timeouts and staleness

| Rule | Behaviour |
| --- | --- |
| **OPEN TTL** | `OPEN` handoffs older than **30 days** surface a stale-handoff warning in C112 (queue-health style). Not auto-deleted in v1. |
| **CLAIMED TTL** | No automatic expiry in v1. Operator cancel is the escape hatch. |
| **Completed / cancelled retention** | Rows kept; UI shows last 7 days by default (C112). |

### 5.5 Idempotency and duplicates

| Concern | Rule |
| --- | --- |
| **Post idempotency** | Optional `client_request_id`. Duplicate `(from_agent_label, client_request_id)` returns the existing row; no second insert. |
| **Without client_request_id** | Each post creates a new handoff — intentional retries without an id are new work. |
| **Claim / complete / cancel** | Idempotent on already-terminal or already-claimed-by-self states: return the current row (or a clear `REFUSED` when unauthorized), never a second state flip. Optional `client_request_id` on complete and cancel returns the first outcome for `(agent_label, client_request_id, tool)` and writes nothing further. |
| **Notes** | Append by default. Optional `client_request_id` returns the first note for `(agent_label, client_request_id, coordination_add_note)` and appends nothing on replay. Without `client_request_id`, each call appends. |

### 5.6 Rate limits

| Scope | Limit |
| --- | --- |
| Coordination writes per MCP session | At most **10** per rolling minute (post, claim, complete, cancel, note combined) |
| Message / note size | §4.2 |

Exceeding the rate limit returns `REFUSED` and records `mcp_agent_events` with that outcome. C105's
integration-write budget (6/min) is separate and unchanged.

---

## 6. Authorization and owner modules

There is still **one operator workspace** — agents are not tenants. Labels distinguish platforms for
coordination; they do not grant different workspace permissions in v1.

### 6.1 Action matrix

Every coordination action has exactly one owner module, one authorization rule, and one audit rule:

| Action | Owner module | Authorization | Audit |
| --- | --- | --- | --- |
| Post handoff | `server/domain/agent-coordination.ts` → `server/agent-coordination/service.ts` | MCP: non-empty init `agent_label`; `from_agent_label` must equal it | Handoff row + `mcp_agent_events` |
| Claim handoff | same | Directed: label = `to_agent_label`. Open pool: any valid label. Atomic. | Handoff columns + `mcp_agent_events` |
| Complete handoff | same | MCP: only `claimed_by`. Never triggers publish/Drive/import. | Handoff columns + `mcp_agent_events` |
| Cancel handoff (agent) | same | Poster or current claimer; `OPEN` or `CLAIMED` only | Handoff columns + `mcp_agent_events` |
| Cancel handoff (operator) | same service; HTTP in C112 | Operator session / loopback; any non-`COMPLETED` state | Handoff columns (no MCP event when UI-only) |
| Add note | same | Valid `agent_label`; handoff not `CANCELLED` | Note row + `mcp_agent_events` |
| List / get handoffs | `server/agent-coordination/service.ts` (read) | Operator (UI) or MCP reads | — (no mutation audit) |
| Inbox resource | MCP resource adapter (C111) | Same as list | — |

Domain rules live only in `server/domain/agent-coordination.ts`. The MCP layer (C111) and HTTP
routes (C112) call the service; they do not re-implement claim or complete checks.

### 6.2 Provider-publish rejection (non-negotiable)

| Path | Allowed to publish? |
| --- | --- |
| Complete handoff | **No** — state flip only |
| Cancel handoff | **No** |
| Add note | **No** |
| Operator inbox UI | **No** — cancel and view only in v1; publish stays on existing Signal confirm flows |

C110–C112 acceptance criteria must keep this boundary. A future card that wants publish-on-complete
needs its own security decision and does not amend this one quietly.

---

## 7. Audit

| Event | Stored in | Notes |
| --- | --- | --- |
| Handoff created / state change | `agent_handoffs` columns | `updated_at` on every transition; terminal timestamps set once |
| Note added | `agent_handoff_notes` | Append-only; `agent_label`, `at`, bounded body |
| MCP tool invocation | `mcp_agent_events` | Tool name, outcome (`SUCCESS` / `REFUSED` / `FAILURE`), handoff id in structured detail; inherits C105 retention |

**No `integration_events` row** — coordination does not call externals. Adding an integration-log
source for handoffs would imply an external side effect that does not exist.

Secrets never appear in handoff messages, notes, MCP tool results, or `mcp_agent_events` free-text
fields: validate length, refuse credential patterns, run `redactSecrets` on the free-text path.

---

## 8. Threat-model checklist (C109)

Use this checklist in documentation review before C110–C112 merge. Mitigations are settled here;
implementation cards prove them with tests.

| ID | Threat | Mitigation |
| --- | --- | --- |
| H1 | API keys / OAuth tokens in handoff or note bodies | Length bounds + credential-pattern refusal + `redactSecrets` on write (§4.2, §7) |
| H2 | Runaway agent loops spam the queue | 10 coordination writes / rolling minute / MCP session (§5.6) |
| H3 | Two agents claim the same open-pool handoff | Atomic claim transaction; second sees `REFUSED` (§5.3) |
| H4 | Wrong label claims a directed handoff | Directed claim requires exact `to_agent_label` match (§5.3, §6.1) |
| H5 | Completing a handoff publishes or syncs Drive | Complete is a local state flip only; no publish/Drive/import imports (§4.3, §6.2) |
| H6 | Stuck or abusive handoffs with no MCP access | Operator HTTP cancel with required reason (C112) (§5.2, §6.1) |
| H7 | Network MCP exposes coordination without session | C113 inherits C51 session revocation + CSRF + required label header |
| H8 | Implementation reopens C105 transport or provider-write policy | C110–C112 scoped to handoff domain/tools/UI only; stdio remains; provider writes stay UI-confirmed |

Verification checklist:

- [x] Handoff messages cannot contain API keys or OAuth tokens (validation + redaction).
- [x] Rate limits prevent handoff spam from a runaway agent loop.
- [x] Claim is atomic — two agents cannot claim the same open-pool handoff.
- [x] Directed handoff cannot be claimed by wrong label.
- [x] Completing a handoff does not call publish, Drive, or import paths.
- [x] Operator can cancel abusive or stuck handoffs without MCP access.
- [x] Network phase (C113) inherits C51 session revocation.
- [x] Implementation cards do not reopen C105 provider-write or transport decisions.

---

## 9. Example flow

1. **Cursor** (`agent_label: cursor`) drafts a Signal post locally, posts handoff: “Review caption
   tone for brand X” → `subject_type: signal_post`, `to_agent_label: claude-code`.
2. **Claude Code** lists inbox resource, claims handoff.
3. Claude edits the post via `signal_update_post`, adds note: “Tightened opening hook.”
4. Claude completes handoff.
5. **Operator** opens inbox UI, sees chain, publishes from UI with normal confirmation.

Provider publish never runs inside steps 1–4.

---

## 10. Cross-references

- [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) — MCP trust boundary (C105), tool
  surface MCP-C106–MCP-C108, network C113.
- [`cloud-hosting.md`](cloud-hosting.md) §5 — operator auth prerequisite for C113.
- [`AGENTS.md`](../AGENTS.md) — Signal authority, integration log rules.

---

## 11. Verification (this card)

- [x] Cards C109–C113 are bounded and ordered.
- [x] Provider publishing stays UI-confirmed throughout.
- [x] §4–§8 settle primitives, identity, auth, lifecycle, claims, idempotency, rate limits, audit, and threats.
- [x] `npm run format:check` when merged into repo.
- [x] No runtime, schema, or dependency change in this PR.

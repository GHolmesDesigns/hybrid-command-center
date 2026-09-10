# Agent Hub — GitHub issue bodies (C202–C219)

**Prepared** 10 September 2026  
**Filed** 10 September 2026 on [Command Center v6.0.0 (project 10)](https://github.com/users/GHolmesDesigns/projects/10)  
**Source** `docs/iterations/AGENT_HUB_CARDS.md` + epic decisions (10 Sep 2026)  
**Convention** `AGENTS.md` — one card per branch `<type>/<issue>-<slug>`, draft PR + `changes/<issue>.md` until review, one version bump per merged card  

| Card | Issue | Branch slug |
| --- | --- | --- |
| C202 | [#588](https://github.com/GHolmesDesigns/hybrid-command-center/issues/588) | `feat/588-agent-conversations-view` |
| C203 | [#589](https://github.com/GHolmesDesigns/hybrid-command-center/issues/589) | `feat/589-agent-memory-review` |
| C204 | [#590](https://github.com/GHolmesDesigns/hybrid-command-center/issues/590) | `feat/590-agent-presence-summaries` |
| C205 | [#591](https://github.com/GHolmesDesigns/hybrid-command-center/issues/591) | `feat/591-agent-notifications` |
| C206 | [#592](https://github.com/GHolmesDesigns/hybrid-command-center/issues/592) | `feat/592-live-work-sessions` |
| C207 | [#593](https://github.com/GHolmesDesigns/hybrid-command-center/issues/593) | `feat/593-work-session-responses` |
| C208 | [#594](https://github.com/GHolmesDesigns/hybrid-command-center/issues/594) | `feat/594-waiting-on-you-inbox` |
| C211 | [#595](https://github.com/GHolmesDesigns/hybrid-command-center/issues/595) | `feat/595-task-detail-route` |
| C209 | [#596](https://github.com/GHolmesDesigns/hybrid-command-center/issues/596) | `feat/596-scoped-discussion-panels` |
| C210 | [#597](https://github.com/GHolmesDesigns/hybrid-command-center/issues/597) | `feat/597-mention-opens-handoff` |
| C212 | [#598](https://github.com/GHolmesDesigns/hybrid-command-center/issues/598) | `feat/598-agent-charter-field` |
| C213 | [#599](https://github.com/GHolmesDesigns/hybrid-command-center/issues/599) | `feat/599-conversation-decision-tags` |
| C214 | [#600](https://github.com/GHolmesDesigns/hybrid-command-center/issues/600) | `feat/600-publish-confirmation-gate` |
| C215 | [#601](https://github.com/GHolmesDesigns/hybrid-command-center/issues/601) | `feat/601-scheduled-agent-runs` |
| C216 | [#602](https://github.com/GHolmesDesigns/hybrid-command-center/issues/602) | `docs/602-thread-rollup-design` |
| C217 | [#603](https://github.com/GHolmesDesigns/hybrid-command-center/issues/603) | `feat/603-agent-cost-records` |
| C218 | [#604](https://github.com/GHolmesDesigns/hybrid-command-center/issues/604) | `feat/604-mention-handoff-notification` |
| C219 | [#605](https://github.com/GHolmesDesigns/hybrid-command-center/issues/605) | `feat/605-agent-hub-sse-wakeup` |

Repo milestones: **#49** Wave 35, **#50** Wave 36, **#51** Wave 37, **#52** Wave 38.

---

## Milestone map

| Milestone | Cards |
| --- | --- |
| Wave 35 — Open the doors | C202, C203, C204, C205 |
| Wave 36 — What is waiting on me | C206, C207, C208 |
| Wave 37 — Threads bind to the workspace | C211, C209, C210 |
| Wave 38 — Hub extensions | C212, C213, C214, C215, C216, C217, C218, C219 |

**Wave 35 delivery order:** C202 + C203 first, then C204 + C205 in parallel.  
**Wave 35 e2e** lands on **C205**. **Wave 36 e2e** lands on **C208**. **Wave 37 e2e** lands on **C210**.

---

# C202 — Conversations reach the operator

**GitHub title:** C202 — Conversations reach the operator  
**Labels:** `feat`, `tier-2-ui`, `size-xxl`  
**Milestone:** Wave 35 — Open the doors  
**Branch:** `feat/<issue>-agent-conversations-view`  
**Depends on:** —  
**Blocks:** C205 (e2e), C209, C210, C213  

### Epic decisions applied

- Dedicated route **`/agents/conversations`** with nav entry (not Agents-tab-only).
- **Freeform** threads allowed but **de-emphasized** in create UX (scoped default).
- **Frozen message provenance** at post time (`UNKNOWN` \| `ASSERTED` \| `VERIFIED` from directory at send).
- **Full MCP tool parity** for conversation read/write (agents currently HTTP-only).

### Problem

Wave 33 (C194) shipped conversation routes and SQLite persistence with no operator UI. Agents can open scoped threads, post, and archive over MCP/HTTP; the operator can post as `'operator'` (`server/app.ts:3024-3030`) but nothing renders threads.

`listMessages` pages forward only (`server/agent-conversations.ts:171`). The browser cannot open a long thread at its newest messages without walking from the beginning.

Messages carry no immutable trust snapshot; directory `trustLevel` can change after a post, rewriting historical interpretation.

### Scope

**Server — pagination**

- Extend `GET /api/agent-conversations/:id/messages` with an optional **before** direction (or equivalent) for reverse paging.
- Default (no direction) remains forward cursor — **byte-identical** responses for existing callers.

**Server — message provenance**

- Add nullable or non-null provenance column(s) on `agent_conversation_messages` storing `senderProvenance: AgentIdentityProvenance` at insert time.
- Resolve from registered agent directory at post time; operator posts use a fixed operator provenance label in shared vocabulary.
- Expose on HTTP read types in `shared/agent-conversations.ts`; never recompute from current directory on read.

**Server — MCP**

- Register MCP tools mirroring conversation service methods: list, create, get, list messages (both directions), post message, archive.
- Map each tool to one service method; respect existing MCP write budgets and session identity as sender.
- Add deterministic MCP eval scenarios for at least create + post + list.

**Client**

- Route **`/agents/conversations`** + nav entry (`App.tsx` pattern).
- **Thread list:** title, scope badge, participants, message count, relative `updatedAt`; filter `ACTIVE` / `ARCHIVED`; cursor “load more”.
- **Thread detail:** open newest page, render oldest→newest within page, load older above; no duplicates at boundaries.
- **Compose:** post as operator (no client-supplied author).
- **Create thread:** title, scope, optional participants; scoped types require id (mirror `conversationScopeSchema`); freeform behind explicit “Unscoped thread” choice.
- **Archive** with confirmation.
- Show **provenance badge** per message (pair color with text per a11y rules).
- Typed helpers in `client/src/api.ts` for C203–C205 reuse.

### Out of scope

- SSE / live push (C219).
- Scoped panels on object pages (C209).
- Mentions → handoff (C210).
- Markdown bodies.
- Read receipts / unread state.

### Acceptance criteria

- [ ] Thread list shows scope, participants, message count, last activity; empty uses `Empty`.
- [ ] `ACTIVE` / `ARCHIVED` filter survives reload.
- [ ] Forward-cursor callers omitting direction get byte-identical pages.
- [ ] Long thread opens at newest page; older pages load above; no duplicate/drop/reorder at boundaries.
- [ ] Operator message appears as `operator` without full reload.
- [ ] Project-scoped create without id refused client-side and server-side.
- [ ] 4001-character message refused before send.
- [ ] Archive moves thread to `ARCHIVED` list.
- [ ] Each message shows **frozen** provenance matching directory at send time; changing directory later does not change stored message provenance.
- [ ] MCP: agent creates thread, posts, lists messages; operator reply visible on agent's next MCP read.
- [ ] Failed requests show error, not infinite spinner.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:eval-mcp` (new conversation scenarios). Manual cross-client round trip per original C202 verification.

### Release fragment

`changes/<issue>.md` — **Added:** Conversations page, reverse message paging, message provenance display, conversation MCP tools.

---

# C203 — The memory review queue

**GitHub title:** C203 — The memory review queue  
**Labels:** `feat`, `tier-2-ui`, `size-l`  
**Milestone:** Wave 35 — Open the doors  
**Branch:** `feat/<issue>-agent-memory-review`  
**Depends on:** — (reuse C202 `api.ts` helpers when available)  
**Blocks:** C205 (`memory` notification destination), C208  

### Epic decisions applied

- **Full MCP tool parity** for memory (suggest, list, get, approve, correct, archive, delete).
- **`POST /api/agent-memory/:id/approve`** for unchanged approval.
- Approve and correct **only from `SUGGESTED`** (guard both new route and existing `PATCH`).

### Problem

Memory is write-only in practice: every suggestion stays `SUGGESTED` because there is no approval UI. `PATCH` requires a non-empty correction (`agentMemoryPatchSchema` refine) and always sets `APPROVED`, so unchanged approval has no honest path.

### Scope

**Server**

- `POST /api/agent-memory/:id/approve` — transitions `SUGGESTED` → `APPROVED`, sets `approvedBy`, `updatedAt`; does not alter key/value/scope/source/expiry.
- Refuse approve/correct when state ≠ `SUGGESTED`.
- **MCP tools:** suggest, list, get, approve, correct (patch), archive, delete — one service method each.

**Client**

- Memory review surface on Agents page (card or section).
- Default filter `SUGGESTED`; filters for scope type, scope id, state.
- Row shows key, value, scope, `source`, `suggestedBy`, `createdAt`, human-readable `expiresAt`.
- Actions: approve, correct+approve, archive, delete (confirmed).
- Correction sends only changed fields; empty correction not submittable.

### Out of scope

- Bulk approve.
- Conflict detection (deferred).
- Approved memory on object pages (deferred).
- Retention / credential rule changes.

### Acceptance criteria

- [ ] Default queue is `SUGGESTED` with full provenance fields visible.
- [ ] Unchanged approve → `APPROVED`, fields unchanged, `approvedBy` set.
- [ ] Correct+approve → stored value corrected, state `APPROVED` (assert DB, not just HTTP).
- [ ] Approve/correct on non-`SUGGESTED` refused.
- [ ] Archive vs delete visibly distinct; delete confirms.
- [ ] Scope filters work including `workspace` with null scope id.
- [ ] Credential-shaped value refused with server message verbatim.
- [ ] MCP suggest + approve round trip matches HTTP.

### Verification

`npm test`, gates, MCP eval for memory tools. Manual: three scopes via MCP; approve one, correct one, delete one; MCP list returns approved pair only.

### Release fragment

**Added:** Memory review queue, unchanged approve route, memory MCP tools.

---

# C204 — Presence and current summaries on the Agents page

**GitHub title:** C204 — Presence and current summaries on the Agents page  
**Labels:** `feat`, `tier-2-ui`, `size-m`  
**Milestone:** Wave 35 — Open the doors  
**Branch:** `feat/<issue>-agent-presence-summaries`  
**Depends on:** —  

### Epic decisions applied

- **Shared 15-minute staleness constant** in `shared/` used by presence **`isStale`** and aligned with MCP health dashboard agent-recency display (same threshold vocabulary — not two conflicting “quiet” rules).

### Problem

`GET /api/agents/presence` and `GET /api/agent-summaries` exist; neither is rendered. Directory shows static `availability`, not live presence or evidence-backed summaries.

### Scope

- `AGENT_PRESENCE_STALE_MS` (or equivalent) in `shared/` — single source for presence `isStale` and health panel stale/unknown agent activity.
- Presence on `AgentDirectoryCard` from `/agents/presence`: `state`, note, `verifiedAt`, `lastActivityAt`; stale/missing → **unknown** (not `OFFLINE`, not blank).
- **Current agent activity** panel: one snapshot per agent, filter by label, show text, `generatedAt`, full `evidence[]` (link in-app paths).
- Refresh on mount + manual re-check (match `McpHealthPanelCard`).

### Out of scope

- Polling/push.
- Summary history persistence.
- Directory `trustLevel` semantics changes.

### Acceptance criteria

- [ ] Directory shows live presence distinct from directory `availability`.
- [ ] No record → unknown.
- [ ] Stale per shared constant → `isStale: true`, renders unknown.
- [ ] Health dashboard uses same constant for stale boundary (document in code comment).
- [ ] Summaries show all evidence; empty evidence does not imply hidden evidence.
- [ ] Filter by `agentLabel` works.

### Verification

Standard gates. Manual: four presence states via MCP; message + handoff → evidence on summary.

### Release fragment

**Added:** Live agent presence and activity summaries on Agents page.

---

# C205 — Notifications reach the operator

**GitHub title:** C205 — Notifications reach the operator  
**Labels:** `feat`, `tier-3-schema`, `size-xl`  
**Milestone:** Wave 35 — Open the doors  
**Branch:** `feat/<issue>-agent-notifications`  
**Depends on:** C203 for `memory` destination links (can ship without links if C203 open)  
**Blocks:** C218  

### Epic decisions applied

- Destination vocabulary v1: **`conversation`**, **`handoff`**, **`agents`**, **`memory`** (memory links active once C203 merged).
- **`kind` alone never invents a route** — link only from typed `{ type, id }`.
- MCP `agent_create_notification` accepts same destination shape.

### Problem

Notifications dedupe and persist but have no operator reader. List is capped at 100 with no exact `unreadCount`, no mark-all, no deep links.

### Scope

**Server**

- Cursor-paged list + exact **`unreadCount`** in list response.
- `POST /api/agent-notifications/mark-all-read` — one transaction, idempotent retry.
- Optional `destination: { type, id }` on create + stored column; Zod enum for types above; validate ids exist for typed destinations.
- Update `agent_create_notification` MCP input schema.

**Client**

- Shell indicator: exact unread count; hide badge when zero.
- Panel: newest-first, kind, agent, title, body, time; read/unread filter default unread; mark one / mark all.
- Destination links only when descriptor present.
- Keyboard reachable; AT announces unread count.

**E2E (Wave 35 milestone spec — this card)**

- Operator opens conversation at newest messages, replies, approves unchanged memory, follows notification typed destination.

### Out of scope

- Browser/OS notifications.
- `NEEDS_INPUT` auto-notify (inbox-only decision).
- Preference screen.

### Acceptance criteria

- [ ] `unreadCount` exact; >100 unread still correct total; page without duplicates.
- [ ] Mark-all transactional; retry harmless.
- [ ] Mark one updates count and filter.
- [ ] Duplicate `incidentKey` → one visible row.
- [ ] Badge not shown for 0.
- [ ] Destination link resolves for conversation, handoff, agents, memory.
- [ ] Wave 35 e2e passes.

### Verification

Standard gates + **`npm run test:e2e`** (new Wave 35 spec). Manual dedupe test.

### Release fragment

**Added:** In-app notification indicator and panel with deep links.

---

# C206 — Live work sessions become readable

**GitHub title:** C206 — Live work sessions become readable  
**Labels:** `feat`, `tier-3-schema`, `size-l`  
**Milestone:** Wave 36 — What is waiting on me  
**Branch:** `feat/<issue>-live-work-sessions`  
**Depends on:** —  
**Blocks:** C207, C208  

### Problem

`GET /api/agent-work-sessions` returns only **reclaimable** sessions (`lease_expires_at <= now`). Active `NEEDS_INPUT` / `BLOCKED` with valid lease appear on **no route** — the window when answering matters.

### Scope

- New bounded read (separate route or query mode — do not overload reclaimable default): live sessions with unexpired lease in `NEEDS_INPUT` and `BLOCKED`.
- Nullable **`waitingSince`**: set on enter waiting states, preserved through heartbeat/checkpoint, swap on state change between waiting states, clear when leaving waiting.
- Reclaim endpoint behaviour **byte-identical** for fixtures predating this card.

### Out of scope

- UI (C208).
- Operator response (C207).
- Notifications on transition.
- Lease/heartbeat rule changes.

### Acceptance criteria

- [ ] Valid-lease `NEEDS_INPUT` in new read, not in reclaimable read.
- [ ] Expired session reclaim response unchanged (fixture byte match).
- [ ] State filter works.
- [ ] Heartbeats don't move `waitingSince`.
- [ ] Bounded list uses shared limit vocabulary.
- [ ] Reclaim still works/refuses as before.

### Verification

Standard gates; regression test on reclaim fixture is load-bearing.

### Release fragment

**Added:** Live work-session read and waiting clock for operator-visible stalls.

---

# C207 — Operators answer live work sessions

**GitHub title:** C207 — Operators answer live work sessions  
**Labels:** `feat`, `tier-3-schema`, `size-l`  
**Milestone:** Wave 36 — What is waiting on me  
**Branch:** `feat/<issue>-work-session-responses`  
**Depends on:** C206  
**Blocks:** C208  

### Epic decisions applied

- **No notification** on response; C208 inbox routes to response UI.

### Problem

Readable `NEEDS_INPUT` is not answerable. Operator can reclaim expired sessions but cannot respond to live waits.

### Scope

- Append-only **`agent_work_session_responses`** (name as implemented): bounded plain text, `respondedAt`, `respondedBy: 'operator'`.
- Confirmed HTTP POST with idempotency key / confirmation hash pattern consistent with repo confirmations.
- Include unread responses in owning agent's **resume context** (bounded).
- Posting does **not** change session state, lease, handoff, or workspace rows.
- Only live `NEEDS_INPUT` / `BLOCKED` accept responses.

### Out of scope

- Operator resume/complete.
- Mandatory conversation transport.
- Notifications.

### Acceptance criteria

- [ ] Response stored once; visible in resume context.
- [ ] Idempotent retry → no duplicate.
- [ ] Session state, lease, handoff unchanged (assert DB).
- [ ] Expired/completed/missing session refused.
- [ ] Owning agent resumes via existing tools; other agents cannot mutate.

### Verification

Standard gates; prove stored + unchanged state.

### Release fragment

**Added:** Operator responses to live agent work sessions.

---

# C208 — The "Waiting on you" inbox

**GitHub title:** C208 — The "Waiting on you" inbox  
**Labels:** `feat`, `tier-2-ui`, `size-l`  
**Milestone:** Wave 36 — What is waiting on me  
**Branch:** `feat/<issue>-waiting-on-you-inbox`  
**Depends on:** C206, C207; reads best after C203, C205  
**Blocks:** C215  

### Epic decisions applied

- **Link out only** — no inline approve/answer in inbox.
- **No auto-notification** for `NEEDS_INPUT` (inbox is the signal).

### Problem

Four stall sources, four places (or none): live work sessions, suggested memory, stale open handoffs, pending Drive writes.

### Scope

- Server derived projection: kind, agent, `waitingSince`, destination, resolution link — **domain owns ordering** (longest wait first).
- Reuse `isStaleOpenHandoff` for handoffs; canonical timestamps per source.
- Agents page panel + Dashboard compact summary (count + oldest).
- Rows link to C207 response UI, C203 queue, handoffs card, Drive write card.
- Partial source failure → metadata warning; other rows still show.

**E2E (Wave 36 — this card)**

- Agent starts session → `NEEDS_INPUT` → operator responds → agent reads answer in resume context.

### Out of scope

- Inline resolution.
- Fifth source.
- TTL changes.

### Acceptance criteria

- [ ] All four kinds appear and sort correctly cross-kind.
- [ ] Stale handoff yes; fresh handoff no.
- [ ] Every row deep-links to working surface.
- [ ] Empty state explicit.
- [ ] Degraded source doesn't hide others.
- [ ] Wave 36 e2e passes.

### Verification

Standard gates + e2e. Manual four-row test.

### Release fragment

**Added:** “Waiting on you” inbox on Agents and Dashboard.

---

# C211 — Stable task detail route

**GitHub title:** C211 — Stable task detail route  
**Labels:** `feat`, `tier-2-ui`, `size-l`  
**Milestone:** Wave 37 — Threads bind to the workspace  
**Branch:** `feat/<issue>-task-detail-route`  
**Depends on:** —  
**Blocks:** C209  

### Epic decisions applied

- Dedicated **`/tasks/:id`** route; modal deep-links to it (modal may remain for quick view).

### Problem

Task detail is modal-only. Task-scoped conversations need reload-stable URLs for C209 links and C205 destinations.

### Scope

- Route `/tasks/:taskId` rendering existing `TaskDetail` with full page chrome (breadcrumbs, back navigation).
- Modal “open task” navigates to or opens route (product choice: navigate or new tab — prefer in-app route navigation).
- Invalid/missing task → readable error page.
- Breadcrumbs include project/client context per existing conventions.
- Update `handoffSubjectPath` / internal link helpers where task links should prefer route over modal.

### Out of scope

- Discussion panel (C209).
- Task edit form route (may stay modal).
- Signal post routes.

### Acceptance criteria

- [ ] `/tasks/:id` reload-stable; shows same task content as modal detail.
- [ ] Link from Kanban/status opens route or equivalent durable URL.
- [ ] Unknown id → error, not blank shell.
- [ ] Breadcrumbs correct for task → project → client.

### Verification

Standard gates; manual reload on task URL; optional e2e navigation assertion.

### Release fragment

**Added:** Dedicated task detail page with stable URL.

---

# C209 — Discussion on project, client, and task detail

**GitHub title:** C209 — Discussion on project, client, and task detail  
**Labels:** `feat`, `tier-2-ui`, `size-xl`  
**Milestone:** Wave 37 — Threads bind to the workspace  
**Branch:** `feat/<issue>-scoped-discussion-panels`  
**Depends on:** C202, **C211**  
**Blocks:** C210  

### Epic decisions applied

- **Defer `signal_post` conversation scope** — handoffs on Signal detail only if already present elsewhere; no scope widening.
- Server-side exact scope filter **before** pagination (do not extend load-all-then-filter from current `listConversations`).

### Problem

Navigation runs one way: handoffs link to objects, not objects to threads. `conversationScopeSchema` already binds threads to client/project/task.

### Scope

- Extend conversation list API: **`scopeType` + `scopeId` required together**; SQL filter before cursor; refuse type-only/id-only/client-side filter.
- **Discussion** section on project, client, task detail: scoped thread list, recent activity, inline post, start thread pre-scoped (id not editable).
- Related handoffs for same subject with `AGENT_HANDOFF_SUBJECT_TYPE_LABEL`.
- Task links use **`/tasks/:id`** (C211).

### Out of scope

- Signal post conversation scope.
- Mentions (C210).
- Re-scope / move thread.

### Acceptance criteria

- [ ] Project page shows only that project's threads; task page only that task's.
- [ ] Create pre-fills scope; id locked.
- [ ] Inline post visible on `/agents/conversations` and reverse.
- [ ] Empty state + start thread affordance.
- [ ] Server request includes scope params (test asserts query/params, not DOM filter).
- [ ] Related handoffs with state.
- [ ] Task thread links use `/tasks/:id`.

### Verification

Standard gates. Manual two-project isolation test.

### Release fragment

**Added:** Discussion panels on project, client, and task pages.

---

# C210 — A mention opens a handoff

**GitHub title:** C210 — A mention opens a handoff  
**Labels:** `feat`, `tier-3-schema`, `size-xl`  
**Milestone:** Wave 37 — Threads bind to the workspace  
**Branch:** `feat/<issue>-mention-opens-handoff`  
**Depends on:** C202, C209  
**Blocks:** C218  

### Epic decisions applied

- **Confirmed handoffs**, not silent automation.
- **Defer mention notification** to C218.

### Problem

Threads cannot cause work. Operator re-types context into handoffs manually.

### Scope

- Parse `@label` with `AGENT_LABEL_PATTERN`; token boundaries; no email/mid-word false positives.
- Pre-submit preview: confirm per recipient; atomic transaction: message + handoffs + join rows + participant grants.
- Join table message ↔ handoff; idempotency via client request id + unique (message, recipient).
- Unknown label → plain text, no offer.
- `freeform` thread → `freeform` handoff, null subject id.
- Thread shows linked handoffs + state; handoff links back.

**E2E (Wave 37 — this card)**

- Project thread mention → confirm → MCP claim + complete → thread shows completed state.

### Out of scope

- Autonomous agent action on mention.
- Mention notifications (C218).
- Human @mentions.
- Edit/retract mention.

### Acceptance criteria

- [ ] All acceptance criteria from `AGENT_HUB_CARDS.md` C210 (11 items).
- [ ] Wave 37 e2e passes.

### Verification

Standard gates + e2e. Manual MCP claim/complete.

### Release fragment

**Added:** Confirmed @mention handoffs from conversation threads.

---

# C212 — Agent charter field on directory

**GitHub title:** C212 — Agent charter field on directory  
**Labels:** `feat`, `tier-3-schema`, `size-m`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `feat/<issue>-agent-charter-field`  
**Depends on:** —  

### Epic decisions applied

- Optional **charter text** on directory entries — descriptive only, **no executable authority**.

### Problem

Directory lists capabilities and trust; standing responsibility (“owns queue health, reports Mondays”) lives only in external docs.

### Scope

- Nullable `charter` text column on agent registry (bounded length in shared limits, e.g. 4000 chars plain text).
- Operator-editable in Agents directory UI (or settings card) with save confirmation.
- Display on `AgentDirectoryCard` when non-empty; collapsed/expand if long.
- MCP read includes charter; MCP write **off** (operator-only edit) unless explicitly needed — default operator HTTP PATCH only.

### Out of scope

- Versioned charter history.
- Scheduled automation from charter text.
- Agent self-edit without operator.

### Acceptance criteria

- [ ] Charter persists and displays for registered agent.
- [ ] Empty charter → no empty panel noise.
- [ ] Over-limit refused with readable error.
- [ ] Changing charter does not change trustLevel or capabilities.

### Verification

Standard gates.

### Release fragment

**Added:** Optional agent charter text on the directory.

---

# C213 — Lightweight decision tags on conversations

**GitHub title:** C213 — Lightweight decision tags on conversations  
**Labels:** `feat`, `tier-2-ui`, `size-l`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `feat/<issue>-conversation-decision-tags`  
**Depends on:** C202  

### Epic decisions applied

- **Lightweight ledger v1:** tag thread as decision + optional outcome field — not full structured ledger yet.

### Problem

Decisions live in free-form `docs/*.md` without link to the thread and object where they were made.

### Scope

- Conversation flags: `isDecision` (bool), optional `decisionOutcome` (bounded plain text), `decidedAt` (set when marked decided).
- Operator actions on thread detail: “Mark as decision”, edit outcome, clear decision mark (confirm).
- Filter on conversation list: **Decisions** (decided threads).
- Show decision badge on scoped Discussion panels (C209) when viewing linked thread.
- No separate `decisions` table in v1 — fields on `agent_conversations`.

### Out of scope

- Participants/rationale/supersededBy graph (future full ledger).
- Agent MCP write of decision fields.
- Auto-detect decisions from message content.

### Acceptance criteria

- [ ] Mark/unmark decision with outcome text persisted.
- [ ] Decisions filter shows only flagged threads.
- [ ] Scoped object Discussion shows decision badge when applicable.
- [ ] Outcome visible on thread detail and list badge.

### Verification

Standard gates.

### Release fragment

**Added:** Decision tagging and outcomes on conversation threads.

---

# C214 — Publish confirmation gate

**GitHub title:** C214 — Publish confirmation gate  
**Labels:** `feat`, `tier-3-schema`, `size-xl`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `feat/<issue>-publish-confirmation-gate`  
**Depends on:** —  

### Epic decisions applied

- **High-blast-radius publish** follows Drive write request shape: preview, confirmation hash, operator approve, audit — not generalized extraction to other domains yet.

### Problem

Signal publish/submit is human-confirmed in UI paths but lacks the same explicit preview-hash-confirm-audit vocabulary as Drive write requests for operator review queue consistency.

### Scope

- Define publish confirmation request model parallel to Drive writes: pending → approved/denied/expired, preview payload hash, agent attribution where applicable.
- Preview + commit HTTP routes under validated boundary; `integration_events` row on commit.
- Operator queue surface (Agents card or Signal panel section) listing pending publish confirmations with approve/deny.
- Refuse commit when preview stale vs workspace/post state.
- Document operator flow in user-facing terms; no provider write without approval when gate enabled.

**Product note:** Specify in implementation whether gate applies to all submits or configurable — default **on for agent-initiated MCP publish preview paths** if they exist; UI operator publish may bypass only where existing product rules require (document explicitly in issue PR).

### Out of scope

- Generalized approval framework for unrelated domains.
- Changing provider capabilities.
- Auto-publish.

### Acceptance criteria

- [ ] Preview returns stable confirmation hash for fixed post state.
- [ ] Approve executes publish; deny leaves post unchanged.
- [ ] Stale preview refused on commit.
- [ ] Pending item appears in operator queue with agent label when agent-initiated.
- [ ] Integration event recorded SUCCESS/FAILURE appropriately.

### Verification

Standard gates; mock provider tests; manual preview→confirm→submit.

### Release fragment

**Added:** Operator confirmation queue for high-risk publish actions.

---

# C215 — Scheduled agent runs

**GitHub title:** C215 — Scheduled agent runs  
**Labels:** `feat`, `tier-3-schema`, `size-xl`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `feat/<issue>-scheduled-agent-runs`  
**Depends on:** C208  
**Status:** Implement after waiting inbox makes unattended work visible  

### Epic decisions applied

- Reuse **handoff queue** — no second scheduled-work engine.
- Cron creates handoffs with dedupe key, owner, pause, failure policy.

### Problem

Recurring agent work has no first-class schedule; operators cannot see or pause unattended runs.

### Scope

- `agent_schedules` table: `ownerAgentLabel`, cron expression or next-run instant, handoff template (to, subject, message skeleton), `dedupeKey`, `paused`, failure policy enum, last run status.
- Operator UI on Agents: list schedules, pause/resume, run-now (creates handoff), view last outcome.
- Tick runner invoked on app timer or external cron hitting secured endpoint — **document deployment expectation**; default dev: optional manual “run due schedules” admin action.
- Due run → create handoff idempotently on dedupeKey + run window.
- Visible in C208 inbox when handoff stalls.

### Out of scope

- Autonomous publish without handoff claim.
- Multi-tenant schedules.
- Sub-minute precision guarantees.

### Acceptance criteria

- [ ] Paused schedule creates no handoffs.
- [ ] Due schedule creates one handoff per dedupe window.
- [ ] Run-now creates handoff immediately.
- [ ] Failed run records status without corrupting schedule row.
- [ ] Schedule appears in operator list with next run time.

### Verification

Standard gates; fixture time injection tests.

### Release fragment

**Added:** Scheduled agent runs that create handoffs.

---

# C216 — Thread rollup design

**GitHub title:** C216 — Thread rollup design (no implementation)  
**Labels:** `docs`, `size-s`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `docs/<issue>-thread-rollup-design`  
**Depends on:** C202  
**Deliverable:** Design doc + draft acceptance criteria only — **no application code**  

### Epic decisions applied

- **Design card only** — evaluate threshold starting at 50 messages; operator-confirmed rollup; never hide source messages.

### Scope

- Document in `docs/iterations/` or `docs/`: trigger threshold, rollup record shape (summary + evidence), UI flow, MCP implications, retention.
- Draft a future implementation card C216b with acceptance criteria copied from deferred section in `AGENT_HUB_CARDS.md`.
- Review with operator: confirm vs auto-suggest timing.

### Out of scope

- Implementation PR touching `server/` or `client/`.

### Acceptance criteria

- [ ] Design doc merged with explicit non-goals (no message deletion, no auto-summarize on time alone).
- [ ] Draft implementation card ready to file.
- [ ] Threshold recommendation with rationale.

### Verification

Doc review only.

### Release fragment

None (docs-only) or **Changed:** documented thread rollup direction.

---

# C217 — Agent cost records (blocked on provider billing)

**GitHub title:** C217 — Agent cost records (blocked)  
**Labels:** `feat`, `tier-3-schema`, `size-l`, `blocked`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `feat/<issue>-agent-cost-records`  
**Depends on:** authoritative provider billing API (external)  
**Unblock when:** Provider exposes queryable usage with model, quantity, unit/currency, window, attribution confidence  

### Epic decisions applied

- **No local estimates labeled as spend** — records require authoritative provider figures.

### Problem

Agents incur token cost invisible to the workspace; `server/budgets.ts` tracks business budgets, not agent usage.

### Scope (when unblocked)

- `agent_cost_snapshots` append-only: provider, model, raw quantity, unit, currency, window start/end, attribution confidence, agent label nullable.
- Read-only UI on Agents or health: last snapshot per agent, provenance disclaimer matching analytics match-confidence pattern.
- Refresh manual button only; no timer.
- Refuse write without provider response passing validation.

### Out of scope

- Local token counting.
- Billing enforcement / hard stops.
- Provider credential storage in integration log.

### Acceptance criteria

- [ ] Blocked label removed only when live provider fixture test passes in owner-run probe (never CI).
- [ ] When implemented: snapshot stores provider numbers verbatim; UI shows provenance sentence that figures are provider-reported.

### Verification

Blocked: N/A. When live: owner probe transcript per `AGENTS.md` probe conventions.

### Release fragment

**Added:** (when unblocked) Provider-reported agent usage snapshots.

---

# C218 — Notify mentioned agent on confirmed handoff

**GitHub title:** C218 — Notify mentioned agent on confirmed handoff  
**Labels:** `feat`, `tier-2-ui`, `size-m`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `feat/<issue>-mention-handoff-notification`  
**Depends on:** C205, C210  

### Epic decisions applied

- Deferred from C210 — uses C205 notification surface with typed **`handoff`** destination.

### Problem

Confirmed mention handoffs create work silently in the handoff queue unless the agent polls.

### Scope

- On successful C210 confirmed handoff creation, create notification to `toAgentLabel` with `incidentKey` dedupe per handoff id, kind `mention_handoff`, destination `{ type: 'handoff', id }`.
- No notification when operator declines handoff or for unknown labels.
- In-app only (no browser push).

### Out of scope

- NEEDS_INPUT notifications.
- Email/webhook.

### Acceptance criteria

- [ ] Confirm handoff → one notification to recipient with working deep link.
- [ ] Decline / plain post → no notification.
- [ ] Retry idempotent confirm → no duplicate notification (`incidentKey`).
- [ ] Recipient sees notification in C205 panel.

### Verification

Standard gates. Manual confirm + unread count.

### Release fragment

**Added:** In-app notification when an @mention handoff is confirmed.

---

# C219 — SSE shell wake-up for authoritative reread

**GitHub title:** C219 — SSE shell wake-up for authoritative reread  
**Labels:** `feat`, `tier-3-schema`, `size-l`  
**Milestone:** Wave 38 — Hub extensions  
**Branch:** `feat/<issue>-agent-hub-sse-wakeup`  
**Depends on:** C202, C205 shipped and in use  

### Epic decisions applied

- **SSE tip only** — payload never authoritative; client rereads HTTP state (same discipline as MCP change feeds).
- Deferred until after Wave 35 per epic decision.

### Problem

Conversations and notifications refresh only on navigation/manual action; operators miss replies while staying on other pages.

### Scope

- Reuse existing HTTP SSE infrastructure (C133 patterns): shell subscribes to agent-hub tip channel.
- Tips name affected feeds: `conversations`, `notifications` — no message bodies in SSE.
- On tip: debounced reread of unread count + active conversation if on page.
- Auth consistent with app session; no new permission prompt.
- Feature flag or setting default **off** until stable — document.

### Out of scope

- Durable cursor in SSE.
- OS notifications.
- Presence polling via SSE (optional later tip type — do not scope creep).

### Acceptance criteria

- [ ] SSE tip causes notification count reread without full page reload.
- [ ] Open conversation thread rereads messages on tip for that thread id only.
- [ ] SSE payload contains no authoritative business data (test asserts).
- [ ] Disconnect/reconnect graceful; falls back to manual refresh.

### Verification

Standard gates; integration test with mock SSE endpoint.

### Release fragment

**Added:** Live update tips for conversations and notifications (optional setting).

---

## Filing checklist

1. ~~Create milestones: Wave 35, 36, 37, 38 on the project board.~~ Done (repo milestones #49–#52).
2. ~~File issues C202–C219~~ Done (#588–#605); see issue index at top of `AGENT_HUB_ISSUE_BODIES_C202-C219.md`.
3. Set labels per issue; **C217** carries `blocked` until provider API exists.
4. Dependency comments posted on filed issues.
5. Add `changes/<issue>.md` fragment when starting each draft PR.
6. Remember unfinalized `changes/577.md` on `main` before next version assignment.

## Card numbering note

C211 is filed **before** C209 in Wave 37 because task routes block scoped discussion, even though card number 211 > 209. Implementation order: **C211 → C209 → C210**.

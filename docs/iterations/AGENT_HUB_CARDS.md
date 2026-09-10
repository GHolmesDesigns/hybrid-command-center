# Agent Collaboration Hub — Cards

### Ready-to-file issues for the agent hub sprint — **filed 10 Sep 2026**

**Prepared** 10 September 2026
**Written against** `origin/main` `3746f22`, `package.json` 6.4.12 — every file:line citation below was re-checked against this commit
**Source** Wave 33 review (C193–C196), the operator's stated goal: *a central hub where AI assistants collaborate with me and each other in a shared workspace — a forum where projects have a place and chat threads are stored, so the company is managed collaboratively*
**Convention** `AGENTS.md` — one card per branch, `<type>/<issue>-<slug>`, one version bump per merged card, first close in a milestone takes the minor
**Status** C202–C210 filed as #588–#597 (Wave 35–37); Wave 38 extensions C212–C219 filed as #598–#605. C211 is #595. See `AGENT_HUB_ISSUE_BODIES_C202-C219.md` and [project 10](https://github.com/users/GHolmesDesigns/projects/10).

---

## 0. Notes

### The finding these cards come from

Wave 33 shipped three subsystems that have **complete server and MCP surfaces and no operator UI**.
This is not a partial build; the routes are written, validated, and tested. They are simply
unreachable from the browser.

| Subsystem | Card | Server routes | Operator UI |
| --- | --- | --- | --- |
| Agent directory | C193 | `server/app.ts:2875-2877` | `AgentDirectoryCard.tsx` ✅ |
| Conversations | C194 | `server/app.ts:2973-3037` | **none** |
| Scoped memory | C195 | `server/app.ts:2927-2969` | **none** |
| Presence / summaries / notifications | C196 | `server/app.ts:2878-2925` | **none** |

`AgentsView` renders five cards — MCP setup, directory, health, Drive write requests, handoffs
(`client/src/components/AgentsView.tsx:29-35`). None of Wave 33 appears there or anywhere else.

Two consequences worth stating plainly, because they change how the cards are sized:

- **The operator's seat is already built.** `POST /api/agent-conversations/:id/messages` posts as
  `'operator'` (`server/app.ts:3026`), and the route comment records the rule that clients cannot
  supply an author (`server/app.ts:2971-2972`). The forum accepts human posts today. Nothing renders
  them.
- **Memory is currently write-only.** Records land in `SUGGESTED`
  (`shared/agent-memory.ts:5`) and only an operator can approve. With no approval screen, no record
  can ever reach `APPROVED`, so the memory subsystem cannot function as designed until C203 lands.

Most server surfaces are present, but review found four contract gaps that the browser cannot safely
paper over: recent-first conversation pagination, unchanged memory approval, exact notification
counts/bulk reads, and typed notification destinations. **C202–C205 therefore own the smallest
server changes needed by their UI rather than claiming to be client-only.**

### Card and issue numbers (filed)

Wave 34 owns C198–C201: #578–#581 (Signal assignment over MCP, closed). Issue #577 reused the C198
label before that sequence was filed — **card number and issue number must never be inferred from each
other.**

Agent Hub cards **C202–C219** are filed on the repo and [Command Center v6.0.0 (project 10)](https://github.com/users/GHolmesDesigns/projects/10). Milestones: Wave 35 (#49), Wave 36 (#50), Wave 37 (#51), Wave 38 (#52). Full issue bodies and branch slugs: `AGENT_HUB_ISSUE_BODIES_C202-C219.md`. Branch names use the real issue number — e.g. `feat/588-agent-conversations-view`.

### One fragment is already pending

`changes/577.md` remains unfinalized on `origin/main`; Wave 34 consumed `changes/581.md` in 6.4.12.
Whoever serializes the next release must account for #577 before assigning a version.

### Waves and their end-to-end specs

`AGENTS.md` requires **at least one `e2e/` spec per milestone**, not per card. Each wave below names
the one flow its spec must cover.

| Milestone | Cards | Theme | e2e spec covers |
| --- | --- | --- | --- |
| `Wave 35 — Open the doors` | C202–C205 | Finish the contracts and render Wave 33 | Operator opens a thread at its newest messages, replies, approves an unchanged memory, and follows a notification's typed destination |
| `Wave 36 — What is waiting on me` | C206–C208 | Make live requests readable and answerable | An agent requests input; the operator answers it from the inbox; the agent reads the response |
| `Wave 37 — Threads bind to the workspace` | C211, C209–C210 | Discussion lives on the object it is about | A project thread routes two confirmed mentions into linked, claimable handoffs |
| `Wave 38 — Hub extensions` | C212–C219 | Charters, decisions, publish gate, schedules, follow-ups | (per card; C216 design-only, C217 blocked) |

**The last card in each wave lands its spec** — C205, C208, C210. Each flow above deliberately spans
its whole wave rather than the carrying card alone, so the spec cannot be written until the wave is
otherwise complete. A card that lands out of order does not inherit the spec.

### Card index

| # | Issue | Card | Type | Labels | Wave |
|---|---|---|---|---|---|
| C202 | #588 | Conversations reach the operator | feat | `tier-2-ui` `size-xxl` | 35 |
| C203 | #589 | The memory review queue | feat | `tier-2-ui` `size-l` | 35 |
| C204 | #590 | Presence and current summaries on the Agents page | feat | `tier-2-ui` `size-m` | 35 |
| C205 | #591 | Notifications reach the operator | feat | `tier-3-schema` `size-xl` | 35 |
| C206 | #592 | Live work sessions become readable | feat | `tier-3-schema` `size-l` | 36 |
| C207 | #593 | Operators answer live work sessions | feat | `tier-3-schema` `size-l` | 36 |
| C208 | #594 | The "Waiting on you" inbox | feat | `tier-2-ui` `size-l` | 36 |
| C211 | #595 | Stable task detail route | feat | `tier-2-ui` `size-l` | 37 |
| C209 | #596 | Discussion on project, client, and task detail | feat | `tier-2-ui` `size-xl` | 37 |
| C210 | #597 | A mention opens a handoff | feat | `tier-3-schema` `size-xl` | 37 |
| C212 | #598 | Agent charter field on directory | feat | `tier-3-schema` `size-m` | 38 |
| C213 | #599 | Lightweight decision tags on conversations | feat | `tier-2-ui` `size-l` | 38 |
| C214 | #600 | Publish confirmation gate | feat | `tier-3-schema` `size-xl` | 38 |
| C215 | #601 | Scheduled agent runs | feat | `tier-3-schema` `size-xl` | 38 |
| C216 | #602 | Thread rollup design (no implementation) | docs | `size-s` | 38 |
| C217 | #603 | Agent cost records (blocked) | feat | `tier-3-schema` `size-l` `blocked` | 38 |
| C218 | #604 | Notify mentioned agent on confirmed handoff | feat | `tier-2-ui` `size-m` | 38 |
| C219 | #605 | SSE shell wake-up for authoritative reread | feat | `tier-3-schema` `size-l` | 38 |

**Reading the labels.** `tier-3-schema` marks the four cards that add persistence: a notification
destination column (C205), `waitingSince` (C206), an operator-response table (C207), and a
mention-to-handoff join table (C210). The `tier-2-ui` cards still do server work — C202 adds a cursor
direction, C203 an approve route, C204 an `isStale` derivation, C209 an exact scope filter. **No card
in this document is client-only**, so do not read `tier-2-ui` as "browser only" when scoping review.

### The binding is the point

One design constraint runs through every card and should survive review: the reason to build this
rather than run agents through Slack is that **threads are bound to workspace objects and can act on
them**. `conversationScopeSchema` already enforces that a non-freeform thread carries an id
(`shared/agent-conversations.ts:14-17`). Protect that. If freeform threads become the default, the
result is a worse chat application. C209 and C210 are where the binding earns its keep.

---

# Wave 35 — Open the doors

Four cards. C202 is the spine; C203–C205 are independent of each other and of C202, so they can run
in parallel. Each card owns its narrow server prerequisite and the UI that consumes it; none may
widen agent authority or mutate workspace records.

A shared prerequisite worth doing inside C202 rather than as its own card: `client/src/api.ts`
currently exposes **no agent helpers**, and `AgentDirectoryCard` calls the generic
`api('/agents/directory')` (`client/src/components/AgentDirectoryCard.tsx:21`). C202 should establish
whatever typed helper shape the other three reuse.

---

## C202 — Conversations reach the operator

**Type / branch:** `feat/<issue>-agent-conversations-view`
**Size:** XL · **Labels:** `tier-2-ui` `size-xl`
**Depends on:** nothing
**Resolves:** the Wave 33 finding — C194 has no reader

### Problem

Agents can open scoped threads, post messages, and archive them. The operator can do all three over
HTTP today. There is no screen. The forum exists in SQLite and is invisible.

Every route the screen needs exists:

- `GET /api/agent-conversations` — list, filterable by state, cursor-paged (`server/app.ts:2973`)
- `POST /api/agent-conversations` — create (`server/app.ts:2989`)
- `GET /api/agent-conversations/:id` — detail (`server/app.ts:3000`)
- `GET /api/agent-conversations/:id/messages` — cursor-paged history (`server/app.ts:3007`)
- `POST /api/agent-conversations/:id/messages` — post as `operator` (`server/app.ts:3024-3030`)
- `POST /api/agent-conversations/:id/archive` (`server/app.ts:3031`)

Types and bounds are settled in `shared/agent-conversations.ts`: four scope types and two states
(lines 4-7), a 200-character title and up to 50 participant labels (lines 18-24), a 4000-character
message (line 25), and `CursorPage<T>` for both paged reads (line 57).

One contract is missing: `listMessages` pages forward only, `ORDER BY sent_at ASC, id ASC` against a
strictly-greater cursor (`server/agent-conversations.ts:171`). There is no `before` direction, so the
browser cannot open a long thread at its newest messages without walking the whole history from the
beginning.

### Scope

- A **Conversations** route and nav entry, alongside `/agents`
  (`client/src/components/App.tsx:222` for the nav pattern, `:387` for the route).
- **Thread list:** title, scope badge, participants, message count, relative `updatedAt`. Filter by
  `ACTIVE` / `ARCHIVED`. "Load more" driven by `nextCursor`, not a page number — the API is
  cursor-paged and `hasMore` is authoritative.
- **Thread detail:** open on the newest page, render that page oldest-to-newest, and load older
  history above it. Preserve the existing forward cursor as the default for MCP callers; add a
  direction/before contract for the browser rather than reversing an established read.
- **Compose:** a message box that posts as the operator. The author is server-assigned; the client
  must not send one.
- **Create thread:** title, scope type, scope id, optional participant labels. When the scope type is
  not `freeform` the id is required — mirror `conversationScopeSchema` client-side so the operator
  gets the refusal before the round trip, not after.
- **Archive**, with confirmation.
- Typed agent helpers in `client/src/api.ts` for the other three cards to reuse.
- Missing presence is **unknown**, not inferred `OFFLINE`; this card does not create read receipts
  or an unread state. It shows last/recent activity only.

### Out of scope — do not build here

- Real-time push. Threads refresh on navigation and after a post; live updates are deferred (§Deferred).
- Rendering threads on project/client/task pages — that is C209.
- Mentions, routing, or anything that creates work from a message — that is C210.
- Markdown or rich text in message bodies. `messageSchema` is plain text; keep it plain.

### Acceptance criteria

- [ ] A thread list renders with scope, participants, message count, and last activity.
- [ ] Filtering by `ACTIVE` and `ARCHIVED` returns the right threads and the filter survives a reload.
- [ ] Existing forward-cursor callers receive byte-identical pages when they omit direction.
- [ ] The browser opens a long thread at its newest page, loads older messages above it, and stops
      cleanly at the beginning — no duplicate, dropped, or reordered message across a boundary.
- [ ] The operator posts a message and it appears attributed to `operator` without a reload.
- [ ] Creating a `project`-scoped thread without an id is refused in the client with a readable
      message, and the same input is still refused by the server if the client guard is bypassed.
- [ ] A 4001-character message is refused before it is sent.
- [ ] Archiving moves the thread out of the `ACTIVE` list and into `ARCHIVED`.
- [ ] An empty thread list renders the `Empty` primitive, not a blank panel.
- [ ] A failed request shows the error rather than an indefinite spinner.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: seed two threads over MCP
from a second client, then read and reply to both in the browser. Confirm the reply is visible to the
MCP client on its next read — that round trip is the whole point of the card.

---

## C203 — The memory review queue

**Type / branch:** `feat/<issue>-agent-memory-review`
**Size:** L · **Labels:** `tier-2-ui` `size-l`
**Depends on:** nothing (reuses C202's api helpers if it merges second)
**Resolves:** memory records cannot leave `SUGGESTED`

### Problem

`AGENT_MEMORY_STATES` is `SUGGESTED → APPROVED → ARCHIVED` (`shared/agent-memory.ts:5`) and only an
operator promotes a record. There is no approval screen, so **every memory an agent has ever
suggested is still `SUGGESTED` and nothing has ever been approved.** The subsystem is inert.

List, suggest, read, correct-and-approve, archive, and delete routes exist (`server/app.ts:2927-2969`).
One contract is missing: `PATCH` both requires a correction and approves it, so it cannot approve an
unchanged suggestion honestly. Add `POST /api/agent-memory/:id/approve`; it changes only a
`SUGGESTED` record's state, `approvedBy`, and `updatedAt`. Correction remains a separate non-empty
operation and is also allowed only from `SUGGESTED`.

### Scope

- A memory review surface, reachable from the Agents page.
- **Queue view** filtered to `SUGGESTED` by default, with filters for scope type, scope id, and state.
- Each record shows key, value, scope, `source`, `suggestedBy`, `createdAt`, and `expiresAt`.
- Actions per record: **approve**, **correct then approve**, **archive**, **delete** (destructive,
  confirmed).
- Correction uses `PATCH` and must send only changed fields — an empty patch is a server refusal by
  design and should not be reachable from the UI.
- Show `expiresAt` as a human-readable retention statement, not a raw timestamp.

### Out of scope — do not build here

- Editing an already approved memory. Approval and correction are `SUGGESTED`-only; object pages
  may eventually display approved memory but link back here for governed changes.
- Conflict detection between contradictory records. Real, and deferred (§Deferred) — it needs a
  comparison rule that does not exist yet.
- Rendering memory on client or project pages. Deferred; it depends on a decision about whether
  approved memory is operator-editable in place.
- Any change to retention defaults or to `containsCredentialShape`.
- Bulk approve. Approving memory one record at a time is the safeguard, not a paper cut.

### Acceptance criteria

- [ ] The queue defaults to `SUGGESTED` and shows every field an approval decision needs — including
      `source` and `suggestedBy`, since provenance is the reason to approve or refuse.
- [ ] Approving moves a record to `APPROVED` and it leaves the default queue.
- [ ] Approving an unchanged suggestion stores its original key, value, scope, source, and expiry
      unchanged while recording operator approval.
- [ ] Correcting a value and approving stores the corrected value, and the stored `state` is
      `APPROVED` — assert both, not just the response code.
- [ ] A correction that changes nothing is not submittable.
- [ ] Archiving and deleting behave differently and are visibly different actions; delete confirms.
- [ ] Filtering by scope type and scope id narrows the list correctly, including `workspace` scope
      where `scopeId` is null.
- [ ] A value containing a credential shape is refused with the server's message surfaced verbatim.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: suggest three memories over
MCP at workspace, client, and task scope; approve one, correct and approve one, delete one; confirm
an MCP read afterwards returns exactly the approved pair.

---

## C204 — Presence and current summaries on the Agents page

**Type / branch:** `feat/<issue>-agent-presence-summaries`
**Size:** M · **Labels:** `tier-2-ui` `size-m`
**Depends on:** nothing
**Resolves:** C196 presence and summaries have no reader

### Problem

`PRESENCE_STATES` is `AVAILABLE | BUSY | AWAY | OFFLINE` (`shared/agent-summaries.ts:4`), and
`AgentSummary` carries `generatedAt` and an `evidence[]` array (lines 31-37) precisely so a claim can
be traced. These summaries are computed snapshots at read time, not stored or agent-authored
history. `GET /api/agents/presence` and `GET /api/agent-summaries` are live
(`server/app.ts:2878`, `:2899`). Neither is rendered. The directory card shows a coarse
`availability` string but not live presence or the current evidence-backed activity snapshot.

### Scope

- Presence indicators on `AgentDirectoryCard`, driven by `/agents/presence` rather than the
  directory's own `availability` field, showing `state`, the optional `availability` note,
  `verifiedAt`, and `lastActivityAt`.
- A **Current agent activity** panel listing one computed snapshot per registered agent, filterable
  by `agentLabel`, each showing text, `generatedAt`, and its `evidence[]` entries. Do not imply that
  `generatedAt` is the time an agent authored or stored a report.
- Evidence renders as a visible list. If an evidence entry resolves to an in-app path, link it;
  otherwise show it as text. Do not hide evidence behind a disclosure — it is the reason the summary
  is trustworthy.
- The server returns an effective presence plus `isStale`, derived from one shared 15-minute
  threshold. A stale or missing record is **unknown**, distinct from explicit `OFFLINE`.
- **Settle the threshold against the health dashboard on the issue.** This is the app's first
  staleness *boundary*: `freshness` in `server/app-health.ts:6-10` renders agent recency descriptively
  (`Checked 3 minutes ago`) and never calls anything stale. Two surfaces disagreeing about when an
  agent has gone quiet is worse than either rule alone, so record whether the dashboard adopts the
  same threshold or stays deliberately descriptive.

### Out of scope — do not build here

- Polling or push. Refresh on mount and on a manual re-check, matching `McpHealthPanelCard`.
- Persisted or agent-authored summary history. The current endpoint computes snapshots on read.
- Any change to what counts as presence, or to the directory's `trustLevel` semantics.

### Acceptance criteria

- [ ] Each directory entry shows a live presence state distinct from the directory `availability` field.
- [ ] An agent with no presence record renders as unknown — not as blank and not as `OFFLINE`.
- [ ] Presence older than 15 minutes returns `isStale: true` from the server and renders as unknown;
      the threshold is defined once in shared vocabulary.
- [ ] Each registered agent has one current summary with `generatedAt` and every evidence entry visible.
- [ ] Filtering summaries by `agentLabel` narrows the list.
- [ ] A summary with an empty `evidence[]` renders without implying evidence exists.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: set presence to each of the
four states over MCP and confirm each renders. Summaries cannot be posted — `buildSummary` derives
them at read time from an agent's recent messages and handoffs
(`server/agent-summaries.ts:82-94`) — so instead post a conversation message as that agent and open a
handoff naming it, then confirm both appear as evidence entries on its summary.

---

## C205 — Notifications reach the operator

**Type / branch:** `feat/<issue>-agent-notifications`
**Size:** XL · **Labels:** `tier-3-schema` `size-xl`
**Depends on:** nothing
**Resolves:** C196 notifications have no reader

### Problem

`AgentNotification` carries an `incidentKey` for deduplication and a nullable `readAt`
(`shared/agent-summaries.ts:38-47`). List, create, and mark-read are live (`server/app.ts:2906`,
`:2913`, `:2920`). The dedupe logic runs and nobody sees the result.

### Scope

- Cursor-page notification reads with an exact `unreadCount`; preserve the existing bounded default
  response only if compatibility requires it.
- A notification indicator in the app shell showing the exact unread count. Do not infer a total
  from a list capped at 100.
- A panel listing notifications newest-first with `kind`, `agentLabel`, `title`, `body`, `createdAt`.
- Mark one read; mark all unread in one bounded, transactional server operation.
- A read/unread filter, defaulting to unread.
- Add an optional typed destination `{ type, id }`, validated against the supported destination
  vocabulary. Link only from that descriptor; `kind` alone never invents an entity destination.

### Out of scope — do not build here

- Browser or OS notifications. The task timer already owns permission-gated notifications; do not
  build a second permission prompt on this card.
- Changing `incidentKey` dedupe or notification retention.
- A preference screen for which notifications appear. Deferred until there is evidence of volume.

### Acceptance criteria

- [ ] The unread count matches `unreadOnly` and reaches zero when everything is read.
- [ ] More than 100 unread rows still report the exact total and can be paged without duplicates.
- [ ] Mark-all changes every unread row in one transaction; retrying it is harmless.
- [ ] Marking one read updates `readAt` and the count, and the row moves out of the unread filter.
- [ ] Two notifications sharing an `incidentKey` appear once, confirming dedupe is visible rather
      than merely implemented.
- [ ] The indicator is not rendered as a badge showing `0`.
- [ ] The panel is reachable by keyboard and announces its unread count to assistive technology.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, plus the Wave 35 e2e spec. Manual:
post two notifications with the same `incidentKey` and one with a different key; confirm two rows
and a count of two, then follow one typed destination.

---

# Wave 36 — What is waiting on me

C206 establishes the live read and waiting clock; C207 makes a request answerable; C208 composes the
operator inbox. They land in that order. The work-session owner remains the only actor that resumes
execution: an operator supplies a response but never changes an agent's execution state.

---

## C206 — Live work sessions become readable

**Type / branch:** `feat/<issue>-live-work-sessions`
**Size:** L · **Labels:** `tier-3-schema` `size-l`
**Depends on:** nothing
**Blocks:** C207, C208

### Problem

`AGENT_WORK_SESSION_STATES` includes `NEEDS_INPUT` and `BLOCKED`
(`shared/agent-work-sessions.ts:3-11`), and an agent parks a session there over MCP when it needs the
operator. But `GET /api/agent-work-sessions` returns only **reclaimable** sessions
(`server/app.ts:3061-3067`), and `reclaimableWorkSessions` selects on `lease_expires_at <= ?`
(`server/agent-coordination/work-sessions.ts:175`).

So a session that is actively waiting on the operator — lease still valid, state `NEEDS_INPUT` — is
returned by **no HTTP route at all**. The operator cannot be shown a request that has not yet expired,
which is exactly the window in which answering it is useful.

### Scope

- A bounded sibling read for live work sessions, filterable by state and covering at least
  `NEEDS_INPUT` and `BLOCKED` with unexpired leases. Do not overload the reclaimable endpoint.
- A nullable `waitingSince`, set when a session enters `NEEDS_INPUT` or `BLOCKED`, preserved through
  heartbeat/checkpoint updates, replaced when it enters the other waiting state, and cleared when it
  leaves waiting. `updatedAt` and `lastHeartbeatAt` are not operator-wait clocks.
- The existing reclaim behaviour must be unchanged, including the no-argument default.
- Bound the result the way every other list here is bounded.

### Out of scope — do not build here

- Any UI. That is C208.
- Changing lease durations, heartbeat behaviour, or reclaim rules.
- Adding a state to `AGENT_WORK_SESSION_STATES`.
- Answering a request. That is C207.
- Notifying on `NEEDS_INPUT`. Tempting, and it belongs with C205's surface once both exist.

### Acceptance criteria

- [ ] A session in `NEEDS_INPUT` with a valid lease is returned by the new read and is **not**
      returned by the unchanged reclaimable read.
- [ ] A session whose lease has expired still appears in the reclaimable read exactly as before —
      assert the old response is byte-identical for a fixture that predates this card.
- [ ] Filtering by state returns only that state.
- [ ] Heartbeats while waiting do not change `waitingSince`.
- [ ] The result is bounded, and the bound is shared vocabulary rather than a literal in the route.
- [ ] Reclaiming a session still works and still refuses the states it refused before.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. The regression this protects is a
silent change to the existing reclaim response, so the fixture assertion above is the load-bearing
test, not the new filter.

---

## C207 — Operators answer live work sessions

**Type / branch:** `feat/<issue>-work-session-responses`
**Size:** L · **Labels:** `tier-3-schema` `size-l`
**Depends on:** C206
**Blocks:** C208

### Problem

Making `NEEDS_INPUT` readable does not make it resolvable. The operator can currently reclaim an
expired session but cannot answer a live request, and a handoff note has no explicit response or
delivery semantics for the session that is waiting.

### Scope

- An append-only operator response attached to one work session, with bounded plain text,
  `respondedAt`, and server-assigned `respondedBy: 'operator'`.
- A confirmed HTTP write for the operator and inclusion of unread responses in the owning agent's
  bounded resume context.
- Posting a response does **not** change the session state. The owning agent reads it and explicitly
  resumes or transitions through the existing work-session tools.
- Only live `NEEDS_INPUT` and `BLOCKED` sessions accept a response. `BLOCKED` is answerable but only
  the agent decides whether the answer removes the block.
- Idempotency for a retried operator submission.

### Out of scope — do not build here

- Operator-driven session resume or completion.
- Conversations as a mandatory transport for work-session responses.
- Notifications; C205 owns the surface and a later integration may create one on transition.

### Acceptance criteria

- [ ] An operator response is stored once and appears in the target session's resume context.
- [ ] Retrying the same confirmed submission creates no duplicate.
- [ ] Responding leaves the session state, lease, handoff, and workspace records unchanged.
- [ ] A response to an expired, completed, abandoned, or missing session is refused.
- [ ] The owning agent can read the answer and then resume itself through the existing transition
      contract; another agent cannot mutate the session.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Prove stored response state and all
listed unchanged state, not only the HTTP response.

---

## C208 — The "Waiting on you" inbox

**Type / branch:** `feat/<issue>-waiting-on-you-inbox`
**Size:** L · **Labels:** `tier-2-ui` `size-l`
**Depends on:** C206, C207; reads better after C203 and C205
**Resolves:** stalled work is invisible until something breaks

### Problem

Four different things stall on the operator, and each lives on a different screen or on none:

| Stalled thing | Where it lives now |
| --- | --- |
| Work sessions in `NEEDS_INPUT` / `BLOCKED` | nowhere (C206–C207 make them readable and answerable) |
| Memories in `SUGGESTED` | nowhere until C203 |
| `OPEN` handoffs past `AGENT_HANDOFF_OPEN_TTL_DAYS` (30) — `shared/agent-coordination.ts:285` | the handoffs card, mixed with healthy rows |
| Pending Drive write requests | `DriveWriteRequestsCard` |

There is no single answer to "what is stopped because I have not looked at it."

### Scope

- One server-side derived projection normalizing the four sources above into bounded rows with kind,
  agent, `waitingSince`, destination, and resolution capability. The domain/service layer owns
  cross-source ordering; React does not redefine it.
- A full panel on the Agents page plus a compact Dashboard summary showing count and oldest items.
- Each row: what is waiting, which agent, how long it has waited, and a link to the place it is
  resolved. This card **routes**; it does not re-implement approval.
- Sort by wait duration, longest first. Work sessions use `waitingSince`; each other source names
  its canonical timestamp in the shared projection.
- `isStaleOpenHandoff` (`shared/agent-coordination.ts:309`) is the existing staleness rule — reuse
  it rather than writing a second definition of stale.
- Work-session rows resolve through C207's operator response. `BLOCKED` rows accept information but
  never claim that the operator resumed the agent.
- When nothing is waiting, say so plainly.

### Out of scope — do not build here

- Resolving anything inline. Every row links out to the surface that owns the action.
- A fifth source. Four is the set; adding more is a later card.
- Changing the 30-day TTL or the 7-day history window (`shared/agent-coordination.ts:285-288`).

### Acceptance criteria

- [ ] All four sources appear, each identifiable by kind.
- [ ] Wait duration is computed from the right timestamp per source, and the sort is correct across
      mixed kinds.
- [ ] A stale `OPEN` handoff appears; a fresh one does not.
- [ ] Every row links to a destination that actually resolves it, and no row is a dead end.
- [ ] The empty state is explicit.
- [ ] A malformed/unavailable source is reported in projection metadata and does not suppress valid
      rows from the other sources.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: create one of each of the
four, confirm four rows in the right order, resolve one, confirm it leaves. The Wave 36 e2e starts a
session, requests input, records an operator response, and reads it from agent resume context.

---

# Wave 37 — Threads bind to the workspace

This is where the forum stops being a separate room and becomes how the company is run. Both cards
depend on C202.

---

## C209 — Discussion on project, client, and task detail

**Type / branch:** `feat/<issue>-scoped-discussion-panels`
**Size:** XL · **Labels:** `tier-2-ui` `size-xl`
**Depends on:** C202
**Resolves:** "projects have a place" — navigation only runs one way today

### Problem

`handoffSubjectPath` routes **from** a handoff **to** a project, client, task, or Signal post
(`shared/agent-coordination.ts:366-386`). Nothing routes back. Open a project and there is no way to
see the threads, handoffs, or agent activity about it — even though `conversationScopeSchema` already
stores exactly the binding needed (`shared/agent-conversations.ts:8-17`).

The operator's stated goal is that projects have a place. The data model agrees; the UI does not.

### Scope

- An exact server-side filter requiring `scopeType` and `scopeId` together and applying both before
  cursor pagination. Type-only, id-only, and browser-side post-filtering are refused.
- A stable task-detail route that renders the existing task-detail component and gives task-scoped
  conversations a durable destination; the existing modal may reuse it but is not the deep link.
- A **Discussion** section on project, client, and task detail, listing threads whose scope matches
  that object, with recent-activity indication.
- Post to an existing thread inline, and start a new thread pre-scoped to the object in view — the
  operator should never type a scope id by hand.
- Related handoffs for the same subject alongside, reusing `AGENT_HANDOFF_SUBJECT_TYPE_LABEL`
  (`shared/agent-coordination.ts:388-394`).
- Show last/recent activity only. There is no unread claim or browser-local read receipt; durable
  per-operator read position is a later contract if observed use needs one.

### Out of scope — do not build here

- Signal post scope. `AGENT_HANDOFF_SUBJECT_TYPES` includes `signal_post` but
  `CONVERSATION_SCOPE_TYPES` does not (`shared/agent-conversations.ts:4`). Widening the conversation
  scope vocabulary is its own decision, with a migration; do not smuggle it in.
- Mentions and work routing — C210.
- Moving or re-scoping an existing thread.

### Acceptance criteria

- [ ] A project page shows only threads scoped to that project, and a task page only that task's.
- [ ] Starting a thread from a project pre-fills scope type and id, and the id is not operator-editable.
- [ ] Posting inline appears in the same thread on the Conversations page, and the reverse.
- [ ] An object with no threads renders an empty state with a way to start one.
- [ ] Scope filtering happens server-side — assert the request is scoped, not the render.
- [ ] Related handoffs for the subject appear with their state.
- [ ] A task-scoped conversation links to a reload-stable task URL, not an ephemeral modal state.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: two projects, one thread
each; confirm neither page shows the other's thread.

---

## C210 — A mention opens a handoff

**Type / branch:** `feat/<issue>-mention-opens-handoff`
**Size:** XL · **Labels:** `tier-3-schema` `size-xl`
**Depends on:** C202, C209
**Resolves:** the forum is readable but not load-bearing

### Problem

Conversations and handoffs are unrelated tables. A thread can discuss work; it cannot cause it.
Today an operator reads a thread, then leaves it to open a handoff, and re-types the context that was
already written. The forum stays decorative.

The pieces exist: `agentHandoffPostInputSchema` takes `toAgentLabel`, `subjectType`, `subjectId`, and
a message (`shared/agent-coordination.ts:205-215`), and thread scope already carries a compatible
subject binding.

### Scope

- Parse token-bound `@label` mentions against `AGENT_LABEL_PATTERN` and the registered-agent
  directory. A mention begins at start/whitespace and ends at punctuation/whitespace, so email
  addresses and mid-word strings do not trigger. An agent picker may assist but does not replace
  plain-text parsing.
- Before submit, preview the recognized recipients and let the operator confirm each one. Commit the
  message, selected handoffs, links, and newly required conversation participants in one transaction.
  Declining every handoff posts the message alone.
- **Confirmed, not automatic.** A mention proposes work; the operator confirms it. Silent handoff
  creation from typed text is the wrong default in a system whose whole discipline is explicit
  transitions.
- Link each handoff to its originating message through a join table. One message may open many
  handoffs; a handoff created here has one originating message. A unique message/recipient relation
  plus client request id makes retries and double submission idempotent.
- Add each confirmed recipient to the conversation participants in the same transaction so the
  handoff's backlink is readable by its recipient.
- A mention of an unknown label posts as ordinary text and is not offered as a handoff.
- `freeform` threads may create a `freeform` handoff with a null subject id.

### Out of scope — do not build here

- Agents acting on mentions autonomously. This card routes work to a queue; claiming stays the
  agent's explicit act via `coordination_claim_handoff`.
- Notifying the mentioned agent. Fits C205's surface and should be a follow-up card, not scope creep.
- Mentioning humans. There is one operator identity; a mention vocabulary for people is a separate
  decision.
- Editing or retracting a mention after posting.

### Acceptance criteria

- [ ] `@known-agent` in a posted message offers a handoff; declining posts the message alone.
- [ ] Confirming creates a handoff addressed to that label, carrying the thread's scope as subject.
- [ ] Message, selected handoffs, links, and participant grants commit atomically or not at all.
- [ ] Retrying the same confirmed submission creates no duplicate message, handoff, link, or participant.
- [ ] A handoff created this way is visible in the existing handoffs card and behaves identically to
      a hand-created one through claim and completion — assert against the stored row, not the UI.
- [ ] The thread shows the handoff and its current state; the handoff links back to the thread.
- [ ] `@unknown-label` posts as plain text with no offer.
- [ ] An email address or a label-shaped string mid-sentence does not produce a spurious offer.
- [ ] Two mentions in one message offer two handoffs, and declining one does not cancel the other.
- [ ] A confirmed recipient who was not previously a participant can follow the handoff backlink and
      read the originating message; an unconfirmed mention receives no access.
- [ ] A mention in a `freeform` thread produces a `freeform` handoff with a null subject id.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, plus the Wave 37 e2e spec. Manual:
mention an agent from a project thread, confirm, then claim and complete the handoff from an MCP
client and confirm the thread reflects the completed state.

---

# Deferred — decisions recorded, not cards yet

Each of these is real and none is ready. The contract direction is recorded so later cards do not
reopen settled ground, but timing and detailed acceptance still wait for evidence.

**Live updates — HTTP SSE wake-up, authoritative reread.** Change feeds remain durable cursor-based
resume for agents. The browser will eventually use existing HTTP SSE infrastructure only as a tip
that causes it to reread authoritative HTTP state; an SSE payload is never the durable record.
Deferred until C202 exists and observed use justifies the connection cost.

**Memory conflict detection — deterministic first.** Candidate conflicts share normalized key and
exact scope; an operator may also declare conflict or supersession. No semantic/model comparison
until real false negatives show why deterministic identity is insufficient.

**Memory shown where it is used — read here, govern centrally.** Object pages may display approved
memory and link to the selected record in C203's review queue. They do not edit or approve it in
place; the queue remains the sole mutation surface.

**Thread rollups — message-count-triggered suggestions.** When observed use supports a threshold
(start evaluation at 50 messages), offer an operator-confirmed rollup using the summary-plus-evidence
shape from C196. Never replace or hide source messages; do not summarize merely because time passed.

**Agent charters — descriptive and versioned first.** The directory holds capabilities and trust; a
charter would hold standing responsibility — "Signal editor owns queue health, reports Mondays."
It communicates responsibility but grants no executable authority. Automation requires a separate,
explicitly confirmed schedule or routing rule.

**Scheduled agent runs — cron-created handoffs.** Reuse the existing queue rather than creating a
second scheduled-work model. Each schedule must name owner, next run, deduplication key, failure
policy, and pause control. It follows C208, which makes unattended work visible.

**A decisions ledger — first-class structured records.** Decisions are recorded as hand-written docs today
(`docs/multi-agent-mcp-decision.md`, `docs/signal-client-binding-decision-2026-09-01.md` and
siblings). A record will carry rationale, participants, decided date, linked thread and workspace
object, and `supersededBy`; conversation remains its evidence trail. Tags/templates alone are not a
ledger. This is the strongest candidate for the wave after 37.

**Generalized approval gates — share proven primitives, not domain authority.** `DriveWriteRequestsCard` with its list and approve routes
(`server/app.ts:1484`, `:1506`) is the right shape for any high-blast-radius action — publishing,
deleting, spending. Domain-specific services keep their exact safety rules; only proven preview-hash,
confirmation, expiry, audit, and UI vocabulary may be extracted after a second real consumer exists.

**Provenance in the forum — immutable posting-time snapshot.** Every future message-provenance field
records the sender's `UNKNOWN | ASSERTED | VERIFIED` status when posted. Current directory status may
appear separately but never rewrites historical interpretation. This deserves its own reviewed schema
change rather than opportunistic scope inside C202.

**Per-agent cost — wait for authoritative provider figures.** `server/budgets.ts` tracks the business;
agents have a token cost the workspace cannot see. Do not label local estimates as spend. A future
record requires provider, model, raw quantity and unit/currency, reporting window, and attribution
confidence from an authoritative source that does not exist in this repository yet.

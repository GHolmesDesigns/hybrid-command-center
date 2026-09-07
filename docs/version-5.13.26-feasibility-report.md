# Feasibility Report: Version 5.13.26

**Prepared:** September 7, 2026  
**Source:** `Version 5.13.26.pdf` and read-only repository inspection  
**Status:** Policy draft for item 5 approved  
**Amended:** September 7, 2026 — the task timer section was revised after
version 5.13.27 shipped an MVP (`65fd353`) subsequent to the original
research pass; see that section for the reconciled scope.

## Executive summary

The requested work is feasible, but it falls into two different categories:

- Items 1–3 and 6 are incremental product work that can reuse existing Signal,
  settings, filtering, MCP health, and diagnostics foundations.
- Item 5 is a larger product program. The current system coordinates work between
  agents, but it does not yet provide general conversations, durable memory, or
  human-readable cross-agent summaries.

The persistent task timer and system notification are also feasible. An MVP
already shipped in version 5.13.27 (`client/src/components/TasksView.tsx`,
route `/tasks`) after this report's original research pass, but it is
client-only, in-memory state: it has no persistence, derives remaining time
by decrementing a counter rather than from the wall clock, sends no system
notification, and has a confirmed bug where a running session silently
reassigns to a different task if the original task leaves the active list
mid-session. `shared/types.ts` still has no timer or time-logged field on
`Task`, and no server-side time-entry table exists, so any cross-device
requirement is still a small data-model addition on top of the shipped UI.

## Feasibility summary

| Item | Request | Feasibility | Relative scope | Current evidence |
| --- | --- | --- | --- | --- |
| 1 | Signal modal client selector | High | Medium | Project persistence exists; editor assignment control is missing |
| 2 | Signal defaults and inactive visibility | High | Small–Medium | Settings framework and URL precedence exist |
| 3 | Task filter set | High | Medium | Existing controls; saved presets and server-side filtering are confirmed in scope |
| 5 | Multi-agent peer-to-peer interface | Medium | Large | Coordination foundation exists; conversations and memory do not |
| 6 | Application health dashboard | High | Medium | Health sources and diagnostics exist; aggregate surface is missing |
| — | Persistent task timer and notification | High | Medium | MVP shipped in 5.13.27 (`TasksView.tsx`); persistence, wall-clock timing, notifications, and a task-reassignment bug remain |

## Item 1 — Signal modal client selector

The editor in `client/src/components/SignalView.tsx` displays client context but
does not let the operator assign it. The server already accepts and persists
`projectId` through `server/signal/service.ts`, and
`server/signal/rows.ts` resolves the associated client.

### Recommended implementation

- Add a Client selector to the Signal editor.
- Constrain Project options to the selected client.
- Preserve an explicit “No project” state.
- Validate the client/project relationship on save.
- Test create, edit, reopen, and stored-state behavior.

### Acceptance

Changing the client cannot leave an incompatible project attached. Reopening a
post shows the saved client and project choices.

## Item 2 — Signal defaults and inactive visibility

`shared/view-defaults.ts`, `client/src/components/SettingsView.tsx`, and the
settings routes already support stored view defaults and URL precedence.

The confirmed behavior is:

- The default Signal client is a display default.
- The default Signal client is also an assignment default.
- Inactive records are hidden by default.
- Each category has an intentional show/hide control.
- A direct URL state remains authoritative.

If Client, Project, and Campaign filters are saved as named presets, the
validated settings schema should document this precedence:

> URL override → saved preset/default → application default

## Item 3 — Task filter set

`client/src/components/Kanban.tsx` already provides Client, Project, Priority,
Task Type, Focus, Tags, and free-text search filters. Client/project
compatibility handling and URL-state conventions are reusable.

Confirmed scope includes:

- The current filter controls.
- Saved named presets.
- Server-side filtering.

### Recommended implementation

Reuse one shared filter vocabulary across the UI, saved presets, and server
queries. Validate saved preset contents and enforce the same filtering semantics
server-side. Preserve the existing behavior that removes incompatible project
selections.

### Acceptance

Filters remain correct for tags and deadline focus states, named presets restore
the intended controls, and server-side results match the client-side filter
semantics.

## Item 5 — Multi-agent peer-to-peer interface

The current coordination stack already has agent credentials, MCP discovery,
handoffs, claims, notes, leased work sessions, bounded context, change feeds,
and the `/agents` operator surface.

It does not yet have:

- A human-readable agent directory and profile layer.
- General conversation threads and messages.
- Durable, scoped memory.
- Cross-conversation human summaries.
- Presence and availability semantics.

### Recommended phases

1. Define Agent, Credential, Session, Conversation, Handoff, Memory, and
   Summary as separate concepts.
2. Add agent profiles and capability declarations.
3. Add a separate cursor-readable message model.
4. Add explicit, provenance-bound memory.
5. Add deterministic human summaries.
6. Add notifications and presence.

Conversations should remain separate from handoffs and work sessions. A handoff
is a structured work request; it is not a chat message.

### Approved policy

The following plain-English policy is approved for item 5.

#### Retention

Keep conversations and memories only as long as they help with active work or
meet an agreed audit need. Give the operator a way to archive or delete them.
Do not keep them forever by default.

#### Privacy

An agent may see only the clients, projects, tasks, and messages allowed by its
account and scopes. Never put passwords, tokens, or secrets in messages, memory,
or summaries.

#### Memory ownership

Shared project memory belongs to the workspace and can be corrected or removed
by the human operator. An agent may suggest a memory, but it cannot silently
make a private opinion into shared truth.

#### Participant identity

The server decides who sent a message from the authenticated agent or operator
session. A message cannot claim to come from a different agent just because its
text names that agent.

#### Summary provenance

Every summary must say when it was made and link back to the messages, handoffs,
and evidence it used. A generated summary is a convenience for the human, not
the source of truth.

#### Message versus action

A message shares information, asks a question, or proposes work. It does not
change a task, post, file, or setting by itself. A state-changing request must
use an explicit handoff or approved action, with a clear result recorded
afterward.

## Item 6 — Application health dashboard

Existing building blocks include:

- Public `GET /api/health`.
- Authenticated MCP health aggregation in `server/mcp/health-panel.ts`.
- Shared health rules in `shared/mcp-health.ts`.
- Protocol diagnostics in `server/mcp/connection-status.ts`.
- Existing `/agents` and `/status` UI patterns.

### Confirmed health definitions

The status surface must keep these signals separate:

1. **Process liveness:** the application process responds.
2. **Database readiness:** the database and required application data path are
   ready.
3. **Historical agent activity:** agents have recently connected or operated;
   this is not proof of current reachability.
4. **Active remote-agent verification:** a current check proves that the
   selected agent is connected and able to send and/or receive information.

“Healthy” is therefore meaningful only for the specific signal being reported.
The dashboard must not collapse historical activity into current reachability.

### Recommended implementation

Add an authenticated, read-only aggregate status contract that reports the
separate signals, freshness, partial failures, and last-tested times. Refresh
the status at initial login and provide a button for the operator to force a
re-check. Keep public liveness low-detail and keep detailed MCP diagnostics
under `/agents`, with a concise summary on `/status` or the dashboard.

## Additional request — Persistent task timer and notification

**Status update:** an MVP of this feature has already shipped, in version
5.13.27 (`65fd353`, "feat: add Pomodoro Tasks page", issue #541) — after this
report's original research pass. It lives at `client/src/components/TasksView.tsx`,
routed at `/tasks`, and covers task selection plus a 25/5-minute work/break
clock. The remaining scope is closing the gap between that MVP and the
persistence/notification behavior originally requested, not building from
scratch.

### What is already in place

- A `/tasks` route listing active (non-`COMPLETE`) tasks and letting the
  operator pick one to focus on.
- A visible work/break clock with Start/Pause/Reset controls.
- Switching tasks explicitly resets the session (`reset()` on task click).
- An e2e smoke test (`e2e/tasks-pomodoro.spec.ts`) covering task selection and
  starting a session.

### Confirmed gaps versus the original request

- **No persistence at all.** State lives in local component state
  (`useState`) with no `localStorage`/server write. Navigating to another
  route unmounts `TasksView` and the session is lost — this fails all of
  "close and reopen," "refresh," and "multiple tabs" from the acceptance list
  below, not just the closed-browser notification case.
- **Time is decremented, not wall-clock-derived.** `setInterval` ticks the
  remaining-seconds counter down once per second
  (`client/src/components/TasksView.tsx:29`). Background-tab timer throttling
  in modern browsers will make this drift from real elapsed time; the
  original recommendation to derive remaining time from a stored end
  timestamp still applies.
- **No system notification.** The Notification API is not used; the only
  signal that a phase ended is the in-page clock and label flipping.
- **No server-side time record.** Nothing persists which task a session
  belonged to or how long was spent — there is no cross-device or
  audit-visible time log, only a live in-memory "Working on {task}" label.
- **Confirmed bug — a running timer can silently reassign to a different
  task.** If the selected task drops out of the active list while a session
  is running (for example, someone else marks it complete from the Kanban
  board), the `useEffect` at `client/src/components/TasksView.tsx:23-25`
  reassigns `selectedId` to a different task without calling `reset()`. The
  countdown keeps running and the "Working on X" label silently changes to a
  different task's title mid-session. This is the exact "task completed or
  reassigned while its timer is active" risk flagged below, and it already
  reproduces in the shipped code.

### Recommended implementation (revised)

Rather than a new feature, treat this as three incremental fixes to
`TasksView.tsx`:

1. Persist a versioned session record (task ID, phase, started-at, target-end
   timestamp, paused state, completed-cycle count) to `localStorage` at
   minimum; confirm with the requester whether cross-device visibility is
   needed, since that upgrades this to a server-side time-entry endpoint.
2. Replace the decrementing counter with wall-clock derivation from the
   stored target-end timestamp, and reconcile on mount instead of resetting
   to a fresh 25:00.
3. Stop (not reassign) the running session when its task leaves the active
   list, and only then let the operator pick a new task. Add system
   notifications with graceful degradation when permission is denied.

### Notification boundary

A notification while the page is hidden is straightforward. A notification
after the browser is fully closed requires a service worker with a supported
scheduling or push strategy, or a desktop companion. Notification permission
denial must degrade gracefully to an in-app indication.

### Acceptance

Test:

- Close and reopen.
- Refresh.
- Pause and resume.
- Expiration while closed.
- Corrupted storage.
- Multiple tabs.
- Notification permission granted, denied, and revoked.
- Notification delivery while the page is hidden.
- The distinction between local persistence and cross-device sync.
- Starting a timer on a second task while one is already running.
- The running task is completed, deleted, or reassigned to another
  client/project while its timer is active — confirmed reproducible today;
  must stop the session rather than silently relabeling it.

## Recommended delivery sequence

1. Task filters: current controls, saved presets, and server-side filtering.
2. Signal assignment: dependent Client → Project controls.
3. Signal defaults: display/assignment defaults and inactive visibility.
4. Task timer: close the persistence, wall-clock-timing, notification, and
   task-reassignment gaps in the shipped `/tasks` MVP.
5. Health dashboard: separate status signals, login refresh, and forced
   re-check.
6. Agent directory: profiles, abilities, trust, and availability.
7. Conversations and memory: messages, explicit memory, summaries, and
   notifications as separate increments.

## Cross-cutting risks and controls

| Risk | Why it matters | Control |
| --- | --- | --- |
| Saved-filter scale | Presets and server-side filtering add query and validation paths | Reuse one filter vocabulary and test SQL scope |
| Health semantics | Historical MCP activity does not prove a remote agent is reachable now | Show freshness and distinguish all four health signals |
| Coordination scope | Chat can blur communication, execution, and audit evidence | Keep messages, handoffs, and work sessions separate |
| Privacy and trust | Agent context, memory, and summaries may contain sensitive data | Use server-resolved identity, bounded scopes, provenance, retention, and review |
| SQLite workload | High-volume messages or presence signals could stress the single-writer model | Use bounded retention, cursor reads, indexes, and measure volume |
| Timer reliability | Clock changes, multiple tabs, storage clearing, and permissions can cause false state | Use timestamps, versioned storage, one active interval, and explicit fallbacks |
| Timer task-scoping | Running timer tied to a task that is completed, deleted, or reassigned mid-session, or a second task started while one is running | Define concurrency rule up front; reconcile or stop timer on task lifecycle changes |

## Bottom line

Proceed with items 1–3, the task timer gap-closing work, and item 6 as near-term
increments. Treat item 5 as a product program, not a single feature card. Its
foundation is strong, but peer-to-peer conversation, memory, summaries, and
presence introduce new persistence, privacy, delivery, and trust semantics.

# Feasibility Report: Version 6.0.0

**Prepared:** September 8, 2026
**Source:** `Version 5.13.26.pdf` and repository inspection
**Status:** Approved planning baseline; item 5 policy approved
**Amended:** September 8, 2026 — reconciled to version 6.0.0, the merged
TaskView fix, completed Dependabot chores, and the approved product decisions
recorded below.

## Executive summary

The requested work is feasible, but it falls into two different categories:

- Items 1–3 and 6 are incremental product work that can reuse existing Signal,
  settings, filtering, MCP health, and diagnostics foundations.
- Item 5 is a larger product program. The current system coordinates work between
  agents, but it does not yet provide general conversations, durable memory, or
  human-readable cross-agent summaries.

The persistent task timer and system notification are also feasible. An MVP
shipped in version 5.13.27 and the TaskView reassignment bug was fixed and
merged afterward. The remaining timer work is client-only persistence,
wall-clock reconciliation, notifications, and multi-tab ownership; no
server-side time-entry or cross-device history is planned.

## Feasibility summary

| Item | Request | Feasibility | Relative scope | Current evidence |
| --- | --- | --- | --- | --- |
| 1 | Signal modal client selector | High | Medium | Project persistence exists; editor assignment control is missing |
| 2 | Signal defaults and inactive visibility | High | Small–Medium | Settings framework and URL precedence exist |
| 3 | Task filter set | High | Medium | Existing controls; saved presets and server-side filtering are confirmed in scope |
| 5 | Multi-agent peer-to-peer interface | Medium | Large | Coordination foundation exists; conversations and memory do not |
| 6 | Application health dashboard | High | Medium | Health sources and diagnostics exist; dedicated `/health` surface is missing |
| — | Persistent task timer and notification | High | Medium | MVP shipped; the reassignment bug is fixed and merged; persistence, wall-clock timing, notifications, and multi-tab ownership remain |

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

- URL state has highest precedence.
- An explicit blank/no-client selection is supported and remains intentional.
- The saved/default Signal client is G.Holmes Designs.
- The application fallback is used only when no URL, explicit blank, or saved/default value applies.
- Inactive records are hidden by default.
- Each category has an intentional show/hide control.

If Client, Project, and Campaign filters are saved as named presets, the
validated settings schema should document this precedence:

> URL selection → explicit blank/no-client selection → saved/default client
> (G.Holmes Designs) → application fallback

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

Deliver these phases as multiple cards as needed for full functionality. Item 5
is an approved multi-card product program, not a single implementation card.

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

Add a dedicated `/health` page backed by an authenticated, read-only aggregate
status contract that reports the
separate signals, freshness, partial failures, and last-tested times. Refresh
the status at initial login and provide a button for the operator to force a
re-check. Keep public liveness low-detail and keep detailed MCP diagnostics
under `/agents`, with a concise summary on `/status` or the dashboard.

## Additional request — Persistent task timer and notification

**Status update:** an MVP of this feature shipped in version 5.13.27
(`65fd353`, "feat: add Pomodoro Tasks page", issue #541), and the TaskView
reassignment bug was fixed and merged in a later release — after this
report's original research pass. It lives at `client/src/components/TasksView.tsx`,
routed at `/tasks`, and covers task selection plus a 25/5-minute work/break
clock. The remaining scope is closing the gap between that MVP and the
persistence/notification behavior originally requested, not building from
scratch. The remaining work is to align the timer with the approved local-only
contract below, including no auto-selected replacement task and preservation of
elapsed state.

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
- **Fixed and merged — a running timer no longer silently reassigns to a
  different task.** The merged fix stops the session instead of continuing it
  relabeled under whichever task fills in. Remaining contract work includes
  ensuring that no replacement task is auto-selected and that elapsed state is
  preserved rather than reset.

### Recommended implementation (revised)

Rather than a new feature, treat this as three incremental fixes to
`TasksView.tsx`:

1. Persist a versioned session record (task ID, phase, started-at, target-end
   timestamp, paused state, completed-cycle count) to `localStorage` at
   minimum. Cross-device visibility is explicitly out of scope, so this does
   not require a server-side time-entry endpoint.
2. Replace the decrementing counter with wall-clock derivation from the
   stored target-end timestamp, and reconcile on mount instead of resetting
   to a fresh 25:00.
3. Stop (not reassign) the running session when its task leaves the active
   list, and only then let the operator pick a new task. Add system
   notifications with graceful degradation when permission is denied.

### Approved timer contract

- Timer state is persisted locally on the browser/device; it is not
  cross-device or server-synchronised.
- Only one timer may be active per operator within the browser/device. Because
  state is local-only, the application does not enforce this across devices.
- Selecting another task while a timer is active requires confirmation and
  stopping the current timer. Stopping preserves the elapsed state.
- If the active task becomes unavailable unexpectedly, stop the timer and
  preserve its elapsed state locally. The operator must restart it manually if
  the task becomes reachable again.
- A completed work or break phase advances to the next phase but remains
  paused.
- No historical time record is created.
- One browser tab owns the timer; other tabs are read-only.
- Remaining time is derived from wall-clock timestamps and reconciled after
  suspension or resume.

### Notification contract

- A completed phase sends a system notification.
- Notification settings are available from Settings and include a global
  enable/disable control, separate completion and unavailable/error controls,
  and sound configuration.
- Notifications are not required after the browser is fully closed.
- An operator-initiated deletion may be silent. An unexpected disappearance
  or definitive unavailability of the active task sends a notification.
- Definitive failures are a `404`, an authorization failure, or confirmation
  that the task no longer exists. An unstable or unreachable task sends an
  unavailable notification only when the provider confirms a definitive
  failure.
- Only one unavailable/error notification is sent per incident; repeats are
  suppressed until the task recovers.
- If system notification permission is denied or revoked, show an in-app
  fallback.

### Notification boundary

A notification while the page is hidden is in scope. A notification after the
browser is fully closed is explicitly out of scope. Notification permission
denial must degrade gracefully to an in-app indication.

### Acceptance

Test:

- Close and reopen.
- Refresh.
- Pause and resume.
- Expiration while the page or browser is closed, reconciled on reopen without
  a closed-browser notification.
- Corrupted storage.
- Multiple tabs, including enforcement of one owning tab and read-only peers.
- Notification permission granted, denied, and revoked.
- Notification delivery while the page is hidden.
- Local-only persistence and the absence of cross-device synchronization.
- Confirmation before starting a timer on a second task while one is already
  running.
- Notification settings for completion and unavailable/error incidents,
  including sound configuration and the one-notification-per-incident rule.
- The running task is completed, deleted, or reassigned to another
  client/project while its timer is active — must stop the session rather
  than silently relabeling it (fixed and merged), auto-pick no replacement
  task, and preserve the elapsed clock rather than resetting it.

## Recommended delivery sequence

1. Task filters: current controls, shared/operator presets, and server-side filtering.
2. Signal assignment: dependent Client → Project controls.
3. Signal defaults: display/assignment defaults and inactive visibility.
4. Task timer: close the persistence, wall-clock-timing, notification, and
   task-reassignment gaps in the shipped `/tasks` MVP.
5. Health dashboard: a dedicated `/health` page with separate status signals,
   login refresh, and forced re-check.
6. Item 5 program, delivered across multiple cards: agent directory, profiles,
   abilities, trust, availability, conversations, memory, summaries, and
   notifications.

## Cross-cutting risks and controls

| Risk | Why it matters | Control |
| --- | --- | --- |
| Saved-filter scale | Presets and server-side filtering add query and validation paths | Reuse one filter vocabulary and test SQL scope |
| Health semantics | Historical MCP activity does not prove a remote agent is reachable now | Show freshness and distinguish all four health signals |
| Coordination scope | Chat can blur communication, execution, and audit evidence | Keep messages, handoffs, and work sessions separate |
| Privacy and trust | Agent context, memory, and summaries may contain sensitive data | Use server-resolved identity, bounded scopes, provenance, retention, and review |
| SQLite workload | High-volume messages or presence signals could stress the single-writer model | Use bounded retention, cursor reads, indexes, and measure volume |
| Timer reliability | Clock changes, multiple tabs, storage clearing, and permissions can cause false state | Use timestamps, versioned storage, one owning tab, and explicit fallbacks |
| Timer task-scoping | Running timer tied to a task that is completed, deleted, or reassigned mid-session, or a second task started while one is running | Require confirmation before switching, preserve stopped state, and reconcile definitive task failures |

## Bottom line

Proceed with items 1–3, the task timer gap-closing work, and item 6 as near-term
increments. Treat item 5 as a product program, not a single feature card. Its
foundation is strong, but peer-to-peer conversation, memory, summaries, and
presence introduce new persistence, privacy, delivery, and trust semantics.

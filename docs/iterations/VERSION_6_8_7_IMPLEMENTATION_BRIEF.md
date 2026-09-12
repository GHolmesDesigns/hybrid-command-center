# Version 6.8.7 Implementation Brief

## Purpose

Convert the supplied Version 6.8.7 backlog notes into implementation-ready work. This brief keeps the requested behavior, records the clarified repro and interaction rules, and identifies the existing code seams to reuse.

## Recommended delivery shape

Split the work into seven small cards:

1. **P1 bug** — Command AI New chat does not open a new chat from Recent chat.
2. **P2 UI** — Project status color palette.
3. **P2 UI** — Timer notification control layout.
4. **P2 UI** — Conversations page spacing and composer width.
5. **P2 spike** — Reporting and logging inventory plus safe UI recommendation.
6. **P2 feature** — Start Timer entry point that opens a task without starting its timer.
7. **P2 UI** — Signal filter controls aligned with Status and Tasks.

The bug should be investigated first because the current unit tests already cover a narrower New flow. The spike should precede any reporting-panel implementation.

## 1 Command AI New chat bug

### Reproduction

1. Open the Command AI sidebar.
2. Open a Recent chat.
3. Click **New chat** from the top control or from the middle/thread control.

### Expected result

A new, empty chat opens. The previous thread is no longer selected, its messages are not shown, and the user can compose a message without an API conversation being created until they press **Send**.

### Acceptance criteria

- The top **New** control and the middle **New chat** control produce the same empty-chat state.
- The sidebar remains open and shows the new-chat welcome/composer state.
- The previous thread title and messages are cleared from the visible state.
- History remains available after starting a new chat.
- No `POST /api/agent-conversations` request occurs until the first message is sent.
- Add regression coverage for both entry points after opening a recent chat, not only after composing a new message.

### Codebase inventory

- `client/src/components/CommandAiPanel.tsx:44-200` owns the sidebar state and `startNew()` behavior. The header **New** and thread-level **New chat** both call this function.
- `client/src/components/CommandAiPanel.tsx:104-120` loads active freeform conversations; `openThread()` switches to the thread view and loads messages.
- `client/src/CommandAiPanel.test.tsx:82-190` covers history selection and a narrower New flow. Extend it with the clarified reproduction path.
- `server/app.ts` and `server/agent-conversations.ts` own the conversation API; do not add a new persistence path for an empty chat.

## 2 Project status colors

### Requested mapping

| Status | Requested color |
| --- | --- |
| Planning | Blue |
| Building | Yellow |
| Active | Green, unchanged |
| On hold | Red |
| Complete | Purple |

### Acceptance criteria

- The same mapping is used by project rows, status chips, filters, and detail views.
- Color is paired with the visible status label and status-specific icon; color is never the only signal.
- Final color values pass the existing contrast checks.
- Archived remains visually distinct and is not accidentally remapped.

### Codebase inventory

- `client/src/components/project-status.ts:8-70` is the canonical status order, label, icon, and palette boundary.
- `client/src/components/Projects.tsx:530-538` applies the status presentation to project rows.
- `client/src/styles.css:1321-1343` controls the status-label shape and archived treatment.
- Existing status tests include `client/src/Projects.status.test.tsx`; extend the focused assertions if the palette changes.

## 3 Timer notification layout

### Requested change

Move **Allow notifications** to the top of the Timer notifications section. Place the notification checkboxes below it in a clear vertical list.

### Acceptance criteria

- The permission button appears before the notification options.
- The options remain individually labelled and keyboard reachable:
  - Enable timer notifications
  - Session completion
  - Permission unavailable warnings
  - Sound when supported
- Dependent options remain disabled when the master option is disabled.
- The permission status remains visible and updates after the browser permission request.
- The layout remains usable at narrow widths.

### Codebase inventory

- `client/src/components/SettingsView.tsx:314-387` renders the settings section, four checkbox controls, the permission button, and the permission status.
- `shared/task-timer.ts:1-31` defines the persisted settings schema and defaults.
- `client/src/components/TasksView.tsx:136-196` owns timer state, tab ownership, notification delivery, and reconciliation.
- `client/src/TasksView.notifications.test.tsx` covers permission and notification behavior; preserve those semantics while changing layout.

## 4 Conversations page spacing and composer width

### Requested change

Add sufficient padding on the Conversations page and make the reply input default to the width of the thread content above it. The uploaded screenshots are supporting visual evidence for this request.

### Acceptance criteria

- The detail panel has consistent horizontal padding around the header, decision controls, messages, composer, and Send button.
- The composer aligns with the message/thread content width rather than appearing narrower than the content above it.
- The layout remains readable when messages wrap and on narrow screens.
- The empty, loading, error, archived, and selected-thread states retain their current behavior.
- Add a focused UI assertion or visual regression check for the composer container width/alignment.

### Codebase inventory

- `client/src/components/ConversationsView.tsx:52-390` owns the full-page list/detail layout, message loading, decision controls, and reply composer.
- `client/src/components/ConversationsView.tsx:356-390` renders the messages and reply form.
- `client/src/styles.css:6280-6288` contains related discussion/composer styling; search the adjacent conversation rules before adding a duplicate selector.
- `client/src/components/ConversationTurn.tsx:33-65` owns message presentation and expandable thought summaries.

## 5 Reporting and logging spike

### Goal

Create an inventory of what is already implemented, identify what can safely be exposed in the UI, and recommend the smallest useful operator-facing surface.

### Current inventory

- `docs/debug-logging.md:1-23` documents `LOG_LEVEL` (`debug`, `trace`, `info`, or `silent`) as a private server diagnostic. It explicitly declines a raw log panel.
- `server/app.ts:594-620` configures request logging with an allowlist that excludes headers, query strings, provider messages, stacks, and credentials.
- `server/integration-log.ts:1-170` implements an append-only, bounded, secret-redacting integration activity log.
- `server/app.ts:2990-3009` exposes `GET /api/integrations/activity` with source, correlation ID, and bounded limit filters.
- `client/src/components/HealthView.tsx:1-78` already provides a read-only application-health surface backed by `GET /api/health/dashboard`.

### Recommended spike outcome

Do not expose raw request debug logs. Recommend a read-only integration activity view, likely under Health or Operations, showing timestamp, source, operation, outcome, summary, correlation ID, and redacted error text with bounded pagination/filtering.

### Spike acceptance criteria

- Inventory all current producers of `integration_events` and the fields each writes.
- Document which fields are safe for operators and confirm credentials/payload bytes cannot appear.
- Decide whether the activity view belongs in Health or as a separate Operations page.
- Define empty, loading, failure, retention, and pagination states.
- Produce a follow-on implementation card only if the safe surface is valuable.

## 6 Start Timer entry point

### Requested interaction

Add a **Start Timer** button at the requested source location. Clicking it opens the task in Tasks. The timer does not start automatically; the user must click **Start** in the task view.

### Acceptance criteria

- The button is shown only where a concrete task can be resolved.
- Clicking it navigates to the task in Tasks and selects that task.
- Navigation does not start, pause, reset, or otherwise mutate the timer session.
- The user must manually click **Start** to begin the timer.
- Missing, archived, or inaccessible tasks produce a clear non-destructive result.
- Add browser coverage for navigation followed by the required manual Start click.

### Codebase inventory

- `client/src/components/TasksView.tsx:135-219` restores the timer, reconciles elapsed time, manages tab ownership, and stops a session when its task leaves the active list.
- `client/src/components/TasksView.tsx:301-336` renders the timer and the manual **Start/Pause** control.
- `client/src/components/TasksView.tsx:417-432` selects a task and resets its timer session when the user changes tasks.
- `shared/task-timer.ts:57-112` defines session creation, reconciliation, start, and pause rules.
- `e2e/tasks-pomodoro.spec.ts` is the existing end-to-end seam for proving task selection and timer behavior.

## 7 Signal filter parity

### Requested change

Replace the Signal filter presentation with the same filter interaction pattern used on Status and Tasks, while preserving Signal-specific fields.

### Recommended scope

Reuse the shared visual and interaction pattern for **Client** and **Project**. Keep **Campaign** and **Search post copy** because they are Signal-specific. Do not add unrelated task-only fields such as Priority, Task type, or Focus to the Signal planner.

### Acceptance criteria

- Client and Project controls match the Status/Tasks interaction pattern, including multi-select behavior, clear actions, focus states, and responsive wrapping.
- Campaign and post-copy filters remain available.
- Multiple values within one dimension remain OR; different dimensions remain AND.
- Client, project, and campaign filters remain durable in the URL; copy search keeps its existing transient behavior unless explicitly changed.
- Existing unbound-client and No-campaign options remain reachable.
- Add focused UI coverage for filter selection, clearing, reload persistence, and combined filtering.

### Codebase inventory

- `client/src/components/Kanban.tsx:266-476` defines the Status/Tasks-style multi-select filter pattern, clear behavior, presets, and tag filtering.
- `client/src/components/TasksView.tsx:242-375` defines the Tasks filter dimensions: Client, Project, Priority, Task type, Focus, and URL-backed clearing.
- `client/src/components/SignalView.tsx:2086-2276` defines Signal filter state, query serialization, and durable URL parameters.
- `client/src/components/SignalView.tsx:2489-2571` renders the current Signal filter panel, including Client, Project, Campaign, No campaign, and copy search.

## Evidence

The following screenshots were supplied directly with the request and should be treated as supporting evidence for the relevant UI items, not as a substitute for acceptance criteria:

- `codex-clipboard-1e5ed1df-f336-4611-b060-ac7ef521fb05.png` — Conversations list/detail view.
- `codex-clipboard-648e3415-160f-46cd-a0ca-b29ba471e929.png` — Conversations detail and reply area.
- `codex-clipboard-d1e3062d-5a40-4a7c-8ae4-d4ac7b76257a.png` — Thread messages and composer.
- `codex-clipboard-85e4a0cf-3f0f-44fa-aa4f-5fce5e478428.png` — Composer width reference.

## Validation plan

- Unit/UI: extend the focused Command AI, timer notification, project status, Conversations, and filter tests named above.
- End to end: add or extend one browser spec for the New chat bug and one for Start Timer navigation plus manual start.
- Quality gates: run typecheck, lint, format check, build, coverage, and E2E sequentially where the shared E2E database requires it.
- Manual verification: reproduce New chat from both entry points in the deployed target and confirm the task timer requires the explicit Start click.

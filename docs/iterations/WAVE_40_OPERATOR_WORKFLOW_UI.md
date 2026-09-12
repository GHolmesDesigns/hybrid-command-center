# Wave 40 — Operator workflow and UI polish

**Status:** Ready to file — owner decisions recorded; W40-F blocked on evidence; GitHub cards not yet opened  
**Prepared:** 12 September 2026  
**Revised:** 12 September 2026 — planning review against code; owner decisions recorded for Q2–Q6, Q8, Q11, Q12  
**Source:** Version 6.8.7 backlog notes (`docs/iterations/VERSION_6_8_7_IMPLEMENTATION_BRIEF.md`), operator screenshots for Start Task and Conversations layout (September 2026), planning review against `origin/main`, and the confirmed root-cause analysis in `docs/audits/session-handoff-2026-09-12.md` (§1).  
**Theme:** Fix the Command AI drawer refresh loop (which manifests as a broken New chat), polish high-traffic operator surfaces (Project Status, Conversations, Settings, Signal), add Start Task entry points without auto-starting timers, and spike a safe integration-activity surface under Health.

**Release note:** This wave is named for planning. Version bumps happen at merge time per `AGENTS.md`; do not label branches after a version number. v6.8.8 shipped on main before this wave files (password-change refusal under env hash).

---

## Wave brief

| Question | Locked answer |
| --- | --- |
| What ships? | Seven small cards: one P1 bug (A), one P2 fix (D), one spike (E), three UI polish items (B, F, G), one feature (C). |
| What is out of scope? | Wave 39 drawer/full-page conversation sync; raw request debug logs; duplicate Start Task buttons on Calendar page headers or Task detail modals. |
| W40-A boundary | Drawer-only: fix the `refresh`/`selected` dependency loop and the stale message response after **New** in `CommandAiPanel`; not W39 selection sync. |
| W40-B palette | Exact hex values recorded in the card; On hold uses a muted brick red distinct from the error red (Q2). |
| W40-C placements | Global topbar (reordered) + Kanban card buttons on Project Status only. |
| W40-C global button | Resolves the open task-detail modal, then `/tasks/:taskId`, then the saved timer session; disabled only when none resolves (Q3). |
| W40-C navigation | `/tasks?task=<id>`; durable and written back on list selection; select-only; invalid values show a notice and fall back (Q4, Q5). |
| W40-C timer conflict | Navigation never mutates the timer; Tasks shows the other running session, and **Start**/**Reset** confirm before replacing it (Q6). |
| W40-E outcome | Spike first; the spike decides the activity surface (Q8); follow-on E2 only if inventory proves operator value. |
| W40-F evidence | Operator to re-supply Conversations spacing screenshots; commit under `docs/iterations/evidence/` before implementation. |
| W40-G filters | Extract shared `MultiSelectFilter` with Escape and outside-click dismissal (Q12); Client, Project, and Campaign use it; copy search stays `SearchBox`. |
| Execution order | W40-A first; B, C, D, E, and G may proceed independently; F waits for evidence; E gates only optional E2. |

### Relationship to other work

- **Wave 39** (`docs/iterations/WAVE_39_COMMAND_AI_CONVERSATION_SYNC.md`) remains a separate study. W40-A fixes the existing drawer fetch loop; it does not synchronize drawer and full-page selection. **Land W40-A before W39-A** — the loop already violates W39's "no duplicate fetch loop" criterion and the suite cannot see it (`session-handoff-2026-09-12.md` §1).
- **Session handoff** (`docs/audits/session-handoff-2026-09-12.md`) — §1 is authoritative for W40-A root cause and fix; §2 password finding is closed on main (6.8.8); MCP `resources/read` scope bypass remains open and is out of W40 scope.
- **Import page** already shows integration activity beside import receipts. W40-E must inventory that surface and MCP `integration_list_activity` before recommending Health UI.
- **View-state convention** (`docs/view-state-convention.md`) — W40-C adds a Tasks row for the durable `task` selection.

### Terminology

- **Start Task:** Operator label for navigating to a task in Tasks and selecting it without starting the Pomodoro session. Implementation may use “Start Task” in the topbar and on Kanban cards.
- **Select-only path:** Sets the active task in Tasks without calling `startTaskTimer` or `newTaskTimerSession`.
- **Saved timer session:** The session persisted in local storage and read with `readTaskTimer` (`shared/task-timer.ts`).
- **Global topbar:** The persistent header in `App.tsx` (`top-actions`), present on every page — not page-level `PageHead` actions.

---

## Open decisions

Owner decisions were recorded on 12 September 2026 for Q2–Q6, Q8, Q11, and Q12 and are marked
**Owner decision**. The remaining questions carry a **Selected default**: a planning default that an
owner may override before implementation. If an owner selects a different option, update the
relevant card's acceptance criteria and tests before opening its branch.

### Q1 — W40-A: How should the drawer prevent stale responses after New chat?

**Selected default: A.**

- **A (Recommended):** Keep the `selectedRef` loop fix, clear the ref synchronously in `startNew`, and add a request-generation guard so an older `openThread` cannot commit messages after the operator starts a new chat.
- **B:** Apply only the `selectedRef` dependency fix and accept that an already-running message request may finish in the background.
- **C:** Add full `AbortController` cancellation for every drawer refresh and message request, including close and reopen transitions.

Option B leaves a visible defect: `openThread` sets messages after its await (`CommandAiPanel.tsx:124`), so a pending response lands after **New**, and the new chat's first Send appends to the stale list (`:194`).

### Q2 — W40-B: What palette values ship, and what hue does On hold use?

**Owner decision: A.**

- **A (Selected):** Record exact ink and surface hex values in the card before implementation: Planning blue, Building yellow (dark ochre ink on a pale yellow surface), Active green (unchanged), On hold muted brick red visibly distinct from the error red `--red: #b9473f` used by Blocked and Overdue, and Complete purple. Update `project-status.ts` and `Projects.status.test.tsx` together.
- **B:** Use the error red for On hold as originally requested.
- **C:** Keep On hold amber and choose a Building yellow that stays distinct from it.
- **D:** Treat the colour names as approximate and choose values during implementation.

### Q3 — W40-C: How does the global Start Task button resolve a task?

**Owner decision: A.**

- **A (Selected):** Resolve in order: the task in the open task-detail modal, then the `/tasks/:taskId` route parameter, then the saved timer session's task. Disabled only when nothing resolves or the resolved task is missing, complete, or in an archived project or client. No Kanban selection state is added.
- **B:** Remove the global button; Start Task exists only on Kanban cards.
- **C:** Track a last-selected Kanban card, lift that state to `App`, and leave the button disabled on most pages.

### Q4 — W40-C: What happens when `?task=` cannot be selected?

**Owner decision: A.**

- **A (Selected):** A valid `?task=<id>` overrides the first-task fallback. A missing, complete, archived, inaccessible, or filtered-out task shows a non-destructive notice, then Tasks applies its normal first-task fallback, as `docs/view-state-convention.md` requires for context browsers (explicit URL selection, then deterministic fallback). The timer is not touched.
- **B:** Show a notice and select nothing; requires amending the convention and gating the fallback effect at `TasksView.tsx:204–219`.
- **C:** Fall back silently with no notice.

### Q5 — W40-C: Is `?task=` durable after it is read?

**Owner decision: A.**

- **A (Selected):** Durable. Selecting a task from the list writes `?task=<id>` as a history entry, preserving other parameters, so reload and Back/Forward restore the selection. The first-task fallback does not write the parameter (defaults are omitted from the address). An invalid value stays in the URL until the operator selects a task.
- **B:** One-shot: read on load, then remove it with a replace navigation.
- **C:** Never update the URL; a reload returns to the original task after switching.

### Q6 — W40-C: What does Tasks show and do when another task's session is running?

**Owner decision: A.**

- **A (Selected):** Navigation and select-only loading never mutate the timer. When task X is running and task Y is selected, the Pomodoro card shows Y's idle clock plus a status line naming X and its remaining time. **Start** and **Reset** for Y open a confirmation before replacing X's session; cancelling leaves X running. No confirmation exists on **Start** or **Reset** today (`TasksView.tsx:289–291`, `:310–331`); this is new.
- **B:** Add the confirmation only and keep today's display, which shows X's remaining time beside "Working on Y".
- **C:** Disable **Start** for Y until X is paused or stopped.
- **D:** Pause X automatically and switch when the operator navigates.

### Q7 — W40-D: How should notification permission status update after Allow notifications?

**Selected default: A.**

- **A (Recommended):** Keep a local permission state, update it from the permission request result, and refresh it when the document regains visibility; preserve the existing settings checkboxes.
- **B:** Read `Notification.permission` only during initial render and do not add state.
- **C:** Remove the settings permission button and request permission only when the timer starts.

### Q8 — W40-E: What should the integration activity surface be?

**Owner decision: A.**

- **A (Selected):** Leave the surface to the spike. The spike compares (1) one reusable read-only panel rendered in Import and Health, (2) a link from Health to the Import list, and (3) no Health surface, and records the choice with its evidence before W40-E2 is filed.
- **B:** Decide now on a shared panel in Import and Health.
- **C:** Decide now on a link from Health to Import only.

### Q9 — W40-E: What retention and paging contract does activity use?

**Selected default: A.**

- **A (Recommended):** Keep the existing bound. `INTEGRATION_EVENT_LIMIT` is 200 (`shared/integration-log.ts:129`), every write prunes the table to that size (`server/integration-log.ts:130–133`), and reads are capped at it (`:162`), so the table never holds more than 200 rows and pagination does not apply. Label the retention boundary in the UI; the spike reports whether 200 rows cover operator needs.
- **B:** Raise the retention limit. This widens retention, which is a W40 non-goal, and needs its own card.
- **C:** Add cursor pagination over the 200 retained rows.

### Q10 — W40-F: How should the card prove composer width and alignment?

**Selected default: A.**

- **A (Recommended):** Use a focused browser test at wide and narrow viewports for bounding-box alignment, plus semantic assertions for empty, loading, error, and selected states. Precedent: `e2e/project-spacing.spec.ts`, `e2e/settings-card-height.spec.ts`.
- **B:** Use jsdom class or DOM-structure assertions only.
- **C:** Use screenshots as the only verification.

### Q11 — W40-G: How should Signal's special filter options remain reachable?

**Owner decision: A.**

- **A (Selected):** Always include **Unbound client** and **No campaign** in their multi-select option sets, even when there are no named clients or campaigns. This is an intentional change: today both are hidden when their group is empty (`SignalView.tsx:2504`, `:2545`).
- **B:** Keep the current rule and show them only when named clients or campaigns exist.

### Q12 — W40-G: How does the shared multi-select dropdown dismiss?

**Owner decision: A.**

- **A (Selected):** The shared `MultiSelectFilter` closes on Escape and on a click outside it, returning focus to its summary on Escape. Status, Tasks, and Signal all inherit the behavior.
- **B:** Extract the component without behavior changes and drop "focus" from the acceptance criteria.

### Q13 — Which cards depend on others?

**Selected default: A.**

- **A (Recommended):** Land W40-A first; allow B, C, D, E, and G to proceed independently; start F once evidence is committed; let E gate only optional E2.
- **B:** Hold all UI cards until the E spike is complete.
- **C:** Run every card serially in document order.

---

## Execution order

```text
W40-A (P1 — drawer refresh loop; blocks W39-A)
    ├── W40-E (spike) ──→ optional W40-E2 (Health activity UI)
    ├── W40-B, W40-C, W40-D, W40-G (may parallelize)
    └── W40-F (after evidence is committed)
```

W40-E gates only optional E2. W40-C's contracts are recorded in Q3–Q6 and must be represented by
focused tests before merge.

---

## W40-A — Command AI drawer refresh loop (P1)

**Primary reference:** `docs/audits/session-handoff-2026-09-12.md` §1 (confirmed by static trace and empirical reproduction; fix specified, not yet applied on main).

### Operator-visible problem

After opening a thread in the Command AI drawer, **New** (header) or **← New chat** (thread) appears to do nothing and snaps back to the selected thread. The same loop makes the drawer hammer the API while open with a selection. Field reports look intermittent because several preconditions must align (see below).

`startNew()` itself clears state correctly; the defect is an unbounded self-retriggering fetch loop plus in-flight `refresh` closures that re-select the old thread after **New**.

### Root cause

`CommandAiPanel.tsx` — `openThread` calls `setSelected` with a freshly parsed list object. That invalidates `refresh`'s `useCallback` because `selected` is in its dependency array (~:139). The `[open, refresh]` effect (~:141–144) re-fires on every pass. The other three `refresh` deps (`loadAgents`, `loadConversations`, `openThread`) are stable `useCallback(..., [])` references; **`selected` identity is the only mover**.

While the loop runs, `openThread` also calls `setView('thread')`, so **New chat cannot win** against an in-flight refresh that closed over a non-null `selected`. There is no effect cleanup and no `AbortController`. Closing and reopening the drawer does not reset `selected` because `App.tsx:585` mounts the panel unconditionally — only the effect's `if (!open) return` keeps fetches quiet.

`ConversationsView` performs a similar identity rewrite but is **safe**: it uses a functional `setState` updater and a `selectedRef` for tip handling (~:151–165), so it never reads `selected` from a stale closure inside a dep-driven callback.

### Trigger conditions — all four must hold

1. `open === true` (drawer open; panel stays mounted when closed).
2. `selected !== null` — via Recent/History click (~:256, ~:282) **or** after first **Send** creates a thread (~:182). A first-time operator who sends once is in the loop.
3. The selected row returns on every refresh pass: `state=ACTIVE&limit=50` (~:111) and `scope.type === 'freeform'` (~:112). Archived, scoped, or 51st-newest threads never arm it — reports correlate with workspace size.
4. Every fetch in the pass resolves; the catch at ~:136–138 skips the identity rewrite on failure.

### Impact

~5 requests per loop pass (agents directory, presence, summaries, conversation list, messages). Sustained while the drawer stays open with a selection. Routes are unmetered outside import/Drive (`server/budgets.ts`).

### Reproduction (operator)

1. Open the Command AI sidebar.
2. Open a Recent chat, pick from History, **or** send a first message to create a thread.
3. Click **New** or **← New chat** — thread snaps back; network tab shows repeated fetches.

Also reproduce after step 2 without step 3 to observe sustained fetch traffic alone.

### Expected behavior after fix

- Empty welcome/composer state after **New**; previous thread title and messages cleared.
- Sidebar stays open; History remains available.
- No `POST /api/agent-conversations` until **Send**.
- Drawer open with a selection causes **bounded** refresh traffic (initial load and explicit user actions only — not a self-sustaining loop).
- A message response for the previous thread that resolves after **New** is discarded.

### Fix — five edits (template: `ConversationsView.tsx:151–165`; Q1-A)

Copy the ref pattern, **not** a functional updater — `refresh` must await fetches.

1. After `messagesEndRef` (~:68):
   ```ts
   const selectedRef = useRef<Conversation | null>(null);
   useEffect(() => { selectedRef.current = selected; }, [selected]);
   const threadRequestRef = useRef(0);
   ```
2. In `refresh`, read the ref **after** the await (fixes the `startNew` race):
   ```ts
   const current = selectedRef.current;
   if (current) {
     const fresh = items.find((item) => item.id === current.id);
     if (fresh) await openThread(fresh);
   }
   ```
3. Drop `selected` from `refresh`'s dep array → `[loadAgents, loadConversations, openThread]`.
4. In `openThread`, guard the message commit with a request generation:
   ```ts
   const request = ++threadRequestRef.current;
   // …setSelected, setView, setError, await api(...)
   if (request !== threadRequestRef.current) return;
   setMessages(page.items);
   ```
5. In `startNew`, clear the ref and invalidate pending requests synchronously, before the state setters:
   ```ts
   selectedRef.current = null;
   threadRequestRef.current += 1;
   ```
   The effect-driven ref sync lags one render; without this, a `refresh` resuming in that window still reads the old selection.

**Do not** fix by reducing renders, deep-equality guards inside `openThread`, or throttling — the problem is `selected`'s identity reaching a dependency array. The generation guard in step 4 discards stale results; it does not throttle requests.

### Regression tests

The committed suite **cannot catch the loop today**:

- Default mock returns `items: []` (`CommandAiPanel.test.tsx:23–24`), masking precondition 3.
- The history test (~:82–136) starts the loop and passes only because assertions finish before RTL cleanup unmounts.

Add tests that:

1. Assert **bounded request count** after selecting a thread (loop must not run away).
2. Cover Recent → **New** and thread → **← New chat** after a listed freeform conversation is selected — not only the post-Send New flow (~:138–190).
3. Hold a thread's message request on a deferred promise, click **New**, then resolve it: the old messages must not render, and the new chat's first Send shows only its own message.
4. Avoid `waitFor` / open-ended `act()` waiting for quiescence against the unfixed component — React's work queue never settles while the loop runs.

### Acceptance criteria

- Ref fix applied; no self-sustaining fetch loop with drawer open and a freeform thread selected.
- Header **New** and **← New chat** produce empty-chat state after Recent, History, and post-Send selection.
- A pending message response for the previous thread cannot repopulate the chat after **New**.
- No conversation POST until first Send.
- Bounded-fetch and stale-response regression tests pass.

### Code seams

- `client/src/components/CommandAiPanel.tsx` — `refresh`, `openThread`, `startNew`, `[open, refresh]` effect.
- `client/src/components/ConversationsView.tsx` — ref pattern to copy (~:151–165).
- `client/src/components/App.tsx:585` — panel mounted unconditionally (context only; no change required for W40-A).
- `client/src/CommandAiPanel.test.tsx` — bounded-fetch test, stale-response test, Recent/History → New paths.
- Do not add a server persistence path for empty chats.

### Adjacent findings (separate tickets — not W40-A)

Fix the loop first; reassess whether these still matter:

- `App.tsx:282` — `flash` is not `useCallback`, so it re-fires `ConversationsView`'s `load` on every App render. Not self-sustaining.
- `CommandAiPanel.tsx:90` — `setRegisteredLabels` gets a fresh `.map()` array each pass, re-firing `useMentionHandoffCompose`. A passenger of the loop.

---

## W40-B — Project status color palette (P2 UI)

### Requested mapping

| Status | Current (`project-status.ts:59–64`) | Requested |
| --- | --- | --- |
| Planning | Purple `#6a4a9c` | Blue |
| Building | Blue `#275d8c` | Yellow (dark ochre ink on pale yellow) |
| Active | Green `#2f6f52` | Green (unchanged) |
| On hold | Amber `#8a5711` | Muted brick red — not the error red `#b9473f` |
| Complete | Blue `#315f79` | Purple |
| Archived | Neutral `#5f6764` | Unchanged |

Ink values listed; surfaces and tile washes change with them. Exact new values are recorded in the card before implementation (Q2).

### Acceptance criteria

- Exact ink and surface hex values for all five changed or confirmed statuses recorded in the card body.
- Same mapping across project rows, status chips, filters, and detail views.
- Color paired with label and status icon — never the only signal.
- On hold is visibly distinct from Blocked and Overdue labels, which use the error red.
- Values pass the AA check (`Projects.status.test.tsx:107`) and the colour-removed separation check (`:60`); Building's yellow ink is the likeliest to fail either.
- **Archived** stays visually distinct; not remapped.

### Code seams

- `client/src/components/project-status.ts` — canonical palette.
- `client/src/Projects.status.test.tsx` — contrast and separation fixtures, updated with the palette.
- `client/src/components/Projects.tsx` — row presentation.
- `client/src/styles.css` — status-label and archived treatment (~1321–1343).

---

## W40-C — Start Task entry points (P2 feature)

### Intent

Give operators a fast path from Project Status (and eligible global context) to the Tasks Pomodoro view with the task selected but **not** running. The operator clicks **Start** in Tasks to begin the session.

### Entry points

| Location | Visibility | Task resolution |
| --- | --- | --- |
| **Global topbar** | On every page | Modal task, then route task, then saved timer session (Q3) |
| **Kanban card** (Project Status) | Every task card | That card's `task.id` |

**Not in scope:** extra buttons on Calendar `PageHead`, Task detail modal header, or other page-local headers — the global topbar covers those surfaces.

### Global topbar reorder

Replace the current order (Command AI → Add post → New task) with:

1. **Start Task**
2. **New task**
3. **Add post**
4. **Command AI**

Implement in `client/src/components/App.tsx` (`top-actions`).

### Global Start Task — resolution rules (Q3)

Evaluate in order; the first match wins.

| Context | Enabled? | Task source |
| --- | --- | --- |
| Task detail modal open (`modal.type === 'taskDetail'`) | Yes | The modal's task |
| `/tasks/:taskId` route | Yes | Route param |
| A saved timer session exists | Yes | The session's `taskId` |
| Nothing resolves | **Disabled** | — |
| Resolved task is missing, complete, or in an archived project or client | **Disabled**, with an accessible description of why | — |

`App` already owns the modal state and the task list. Read the saved session with `readTaskTimer` on render and again on `focus` and `storage` events, so a session started in another tab is picked up. Kanban gains no selection state.

### Shared click behavior

- Navigate to `/tasks?task=<id>`.
- **Select-only:** set the active task in Tasks; do **not** call `startTaskTimer`, `pauseTaskTimer`, or `newTaskTimerSession`.
- Operator must manually click **Start** in the Pomodoro card.

### Kanban card layout

On each card in `client/src/components/KanbanCards.tsx`:

```text
┌─────────────────────────────────────────┐
│ [HIGH] [GRAPHICS] [Blocked]  [Start Task] │
│  tags wrap here ──────────────  fixed → │
│ Task title…                             │
└─────────────────────────────────────────┘
```

- **Start Task** fixed top-right of the label row.
- Priority, type, blocked, and overdue chips wrap before encroaching on the button.
- The button is a sibling of the `card-title` button (which opens the detail modal) and the drag handle, so it needs no propagation handling.
- Update `.card-labels` in `client/src/styles.css` (~1908–1913) — reserve right column or grid slot for the button.

### Tasks page changes

- **Selection from `?task=` (Q4):** if the parameter names a task in the filtered active list, select it; this overrides the first-task fallback. Otherwise — missing, complete, archived, inaccessible, or excluded by other URL filters — show a non-destructive notice and apply the normal first-task fallback. Never touch the timer on this path. The existing effect at `TasksView.tsx:204–219` pauses a session whose task leaves the list; the select-only path must not trigger it.
- **Durable selection (Q5):** selecting a task from the list writes `?task=<id>` as a history entry and preserves other parameters. The first-task fallback does not write it. Add a Tasks row to the current-views table in `docs/view-state-convention.md`.
- **Select-only path:** distinct from the task-picker `onClick`, which today calls `setTimer(newTaskTimerSession(task.id))` (`TasksView.tsx:423–432`).
- **Another task's session (Q6):** `seconds` and `mode` currently come from the saved session regardless of selection (`TasksView.tsx:139–142`). When the session belongs to a different task, show the selected task's idle clock and a status line naming the running task and its remaining time. **Start** (`:310–331`) and **Reset** (`:289–291`) for the selected task confirm before replacing that session; cancel leaves it running.

### Acceptance criteria

- Global and Kanban entry points share the same navigate + select-only behavior.
- Global button follows the Q3 resolution order and is disabled when nothing resolves or the task is unavailable.
- A valid `?task=` is selected on load; an invalid one shows a notice and falls back to the first task without timer changes.
- Selecting a task from the list updates `?task=`; reload and Back/Forward restore the selection.
- Timer does not start until manual **Start** in Tasks.
- With another task's session running, Tasks names it in a status line; **Start** and **Reset** confirm before replacing it, and cancel leaves it unchanged.
- E2E extends `e2e/tasks-pomodoro.spec.ts`: Kanban Start Task → Tasks selected → manual Start begins session; and Start Task while another session runs → confirmation shown → cancel keeps the original session.

### Code seams

- `client/src/components/App.tsx` — topbar reorder, global Start Task resolution.
- `client/src/components/KanbanCards.tsx` — per-card button and card header layout.
- `client/src/components/TasksView.tsx` — `?task=` read and write-back, select-only vs picker paths, clash display and confirmations.
- `shared/task-timer.ts` — `readTaskTimer` and session rules (read; avoid widening write surface).
- `docs/view-state-convention.md` — Tasks row.
- `e2e/tasks-pomodoro.spec.ts`.

### Adjacent findings (separate tickets — not W40-C)

- `TasksView.tsx:423–432` — clicking the row of the task already being timed replaces its session and resets the clock without confirmation.
- Same handler — switching away from a paused session discards it without confirmation; the confirm only runs while the session is running.

### Evidence

Operator screenshots (September 2026): global header reorder annotation; Kanban card button placement with tag wrap.

---

## W40-D — Timer notification layout and permission state (P2 fix)

### Request

Move **Allow notifications** to the **top** of the Timer notifications settings section. Checkboxes below in a clear vertical list.

### Current defect

The permission line reads `Notification.permission` only when the section renders (`SettingsView.tsx:386`), and the button discards the request result (`:379`). After the operator answers the browser prompt, the displayed status stays stale until something else re-renders the page. Fix per Q7.

### Acceptance criteria

- Permission button before notification options.
- Labels preserved: Enable timer notifications; Session completion; Permission unavailable warnings; Sound when supported.
- Dependent options disabled when master disabled.
- Permission status visible and updates from the request result and when the document regains visibility.
- Usable at narrow widths.
- `client/src/TasksView.notifications.test.tsx` semantics unchanged.

### Code seams

- `client/src/components/SettingsView.tsx` (~314–387).
- `shared/task-timer.ts` — schema unchanged unless layout requires it (unlikely).

---

## W40-E — Integration activity spike (P2 spike)

### Goal

Inventory logging and integration activity already implemented; recommend the smallest safe operator-facing surface. **Do not** expose raw request debug logs.

### Known starting inventory

| Surface | Role |
| --- | --- |
| `docs/debug-logging.md` | `LOG_LEVEL` server diagnostic; explicitly no raw log panel |
| `server/integration-log.ts` | Append-only, redacted `integration_events`; every write prunes to the newest 200 rows |
| `GET /api/integrations/activity` | Read-only API with source, correlation ID, limit filters; limit capped at 200 |
| `client/src/components/ImportView.tsx` | Already lists activity beside import receipts |
| `server/mcp/integration-tools.ts` | `integration_list_activity` for agents |
| `client/src/components/HealthView.tsx` | Application health; no activity list yet |

### Working hypothesis (the spike confirms or rejects it)

A read-only **integration activity** section under **Health / Operations**, showing timestamp, source, operation, outcome, summary, correlation ID, and redacted error text, with a source filter and a visible retention boundary. Q8 leaves the surface choice to the spike.

### Spike acceptance criteria

- Inventory every producer of `integration_events` and fields each writes.
- Confirm credentials and payload bytes cannot appear in UI.
- Compare the Q8 options — shared panel in Import and Health, link from Health to Import, no Health surface — and record the choice with its evidence.
- Confirm the Q9 retention bound covers operator needs, then define empty, loading, failure, and retention-boundary states. Pagination is not in scope while the bound is 200 rows.
- **Follow-on card (W40-E2)** filed only if spike proves clear operator value.

### Non-goals

- Raw request/debug log panel.
- Widening write paths or retention beyond existing rules.

---

## W40-F — Conversations page spacing and composer width (P2 UI)

### Request

Consistent horizontal padding on the Conversations detail panel. Reply composer matches thread content width (not narrower than messages above).

### Acceptance criteria

- Padding consistent around header, decision controls, messages, composer, and Send.
- Composer aligns with message column width.
- Readable when messages wrap and on narrow screens.
- Empty, loading, error, archived, and selected-thread behavior unchanged.
- Focused browser assertion for composer width/alignment at wide and narrow viewports (Q10).

### Code seams

- `client/src/components/ConversationsView.tsx` — `split-layout`, detail `card`, `.conversation-compose` (~356–395).
- `client/src/styles.css` — `.conversation-*`, `.split-layout` (~6347+, 6738+); avoid duplicating `.discussion-detail` rules (those target a different surface).
- `client/src/components/ConversationTurn.tsx` — message presentation.
- `e2e/project-spacing.spec.ts`, `e2e/settings-card-height.spec.ts` — layout-assertion precedent.

### Evidence (required before implementation)

Re-supply operator screenshots; commit under `docs/iterations/evidence/` with a short index in this wave doc or the card body. Original brief referenced `codex-clipboard-*.png` filenames not present in the repo.

---

## W40-G — Signal filter parity (P2 UI)

### Request

Align Signal **Client**, **Project**, and **Campaign** filters with the Status/Tasks multi-select dropdown pattern. Keep **Search post copy** as transient `SearchBox`. Do not add Priority, Task type, or Focus.

### Implementation decision (locked)

Extract `MultiSelectFilter` from the duplicate copies in `Kanban.tsx` and `TasksView.tsx` (functionally identical) into a shared module; consume from Kanban, Tasks, and Signal. Add Escape and outside-click dismissal in the shared component (Q12).

### Acceptance criteria

- Client, Project, and Campaign use the same interaction pattern as Status/Tasks (multi-select, clear, responsive wrap).
- The dropdown closes on Escape (focus returns to its summary) and on an outside click, on Status, Tasks, and Signal.
- OR within a dimension; AND across dimensions.
- Client, project, campaign filters remain URL-durable; copy search stays transient.
- **Unbound client** and **No campaign** are always listed, even with no named clients or campaigns (Q11 — intentional change).
- Focused UI tests: selection, clear, dismissal, reload persistence, combined filters. Chip-based assertions in `Signal.filters.test.tsx` are rewritten for the dropdown.

### Code seams

- New shared module (for example `client/src/components/MultiSelectFilter.tsx`).
- `client/src/components/Kanban.tsx` — `MultiSelectFilter`, filter bar (~266–476).
- `client/src/components/TasksView.tsx` — duplicate `MultiSelectFilter`, filter dimensions (~242–375).
- `client/src/components/SignalView.tsx` — filter state/URL (~2186+), render panel (~2504–2566); replace `FilterChip` for Client/Project/Campaign.
- `client/src/Signal.filters.test.tsx`, `client/src/Kanban.multi-filter.test.tsx`.

---

## Proposed card sequence

Issue numbers omitted until GitHub occupancy is rechecked. Branch names follow `<type>/<issue>-<slug>` when filed.

| ID | Type | Slug hint | Depends on |
| --- | --- | --- | --- |
| W40-A | fix | command-ai-drawer-refresh-loop | — (blocks W39-A) |
| W40-E | chore | integration-activity-spike | — |
| W40-B | feat | project-status-colors | — |
| W40-D | fix | timer-notification-permission | — |
| W40-F | feat | conversations-composer-layout | evidence committed |
| W40-G | feat | signal-filter-multiselect | — |
| W40-C | feat | start-task-entry-points | — |
| W40-E2 | feat | health-integration-activity | W40-E (optional) |

---

## End-to-end specs (milestone)

Per `AGENTS.md`, this milestone adds at least one E2E spec covering the wave's primary operator flow. Minimum:

1. **Command AI drawer** — open thread → bounded fetches; New chat clears selection (both entry points). No Command AI E2E spec exists yet; this is a new file.
2. **Start Task** — Kanban or global Start Task → `/tasks?task=` → task selected → manual Start begins timer; Start Task while another session runs → confirmation → cancel keeps the session (`e2e/tasks-pomodoro.spec.ts`).

Other cards rely on focused unit/UI tests unless E2E adds disproportionate value.

---

## Non-goals

- Wave 39 drawer/full-page conversation synchronization.
- Raw server request or debug log UI.
- Auto-starting Pomodoro from Start Task entry points.
- Duplicate Start Task on Calendar page headers or Task detail modals.
- Kanban card selection state for the global Start Task button.
- Signal filters for task-only dimensions (Priority, Task type, Focus).
- Drive writes, Signal schedule writes, or integration log write-path or retention changes.

---

## Verification and release gates

- Extend focused tests named in each card (`CommandAiPanel.test.tsx`, `Projects.status.test.tsx`, `TasksView.notifications.test.tsx`, Conversations UI, `Signal.filters.test.tsx`, `Kanban.multi-filter.test.tsx`).
- `npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run test:e2e`.
- Draft branches with `changes/<issue>.md` fragments; finalize version only after review per `AGENTS.md`.

---

## Definition of done

Wave 40 is complete when:

1. Command AI drawer refresh loop is eliminated; New chat works from Recent, History, and post-Send via both entry points; stale message responses are discarded; bounded-fetch and stale-response regression tests pass.
2. Project status colors match the recorded hex values, with On hold distinct from the error red and contrast and separation checks passing.
3. Timer notification settings show permission control first, and permission status updates after the browser request.
4. Conversations detail padding and composer width match evidence and AC.
5. Integration activity spike is documented with Q8 and Q9 recorded; optional Health UI shipped if recommended.
6. Start Task works from the reordered global topbar (per the Q3 resolution order) and Kanban cards without auto-starting the timer; `?task=` is durable; replacing another task's session requires confirmation.
7. Signal Client/Project/Campaign filters use the shared multi-select with Escape and outside-click dismissal; URL and filter semantics preserved; special options always listed.
8. All quality gates green; milestone E2E covers New chat and Start Task flows.

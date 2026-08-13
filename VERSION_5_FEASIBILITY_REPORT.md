# Version 5 Sprint Feasibility and Release Report

Reviewed: 2026-08-13
Source: `C:\Users\garni\Dropbox\GHD Deliverables\House\Version 5.docx` (17 text lines, 13 annotated screenshots)
Repository snapshot: `main` at `b8f2e3a`, version `4.0.0`, working tree clean apart from the staged Version 4 report

## Executive assessment

Version 5 is feasible, and it is a materially smaller and safer sprint than Version 4 was. Fourteen
items: one defect, nine paper-cuts, four feature requests. Eleven of the fourteen are contained
changes to code that already exists and already has tests around it.

Three items are not paper-cuts despite sitting in the list beside ones that are, and each hides a
question the wording does not settle:

- **Draggable tasks on the Projects stage** collides with how task order is stored. `position` is
  scoped to a status column; the project page shows one flat list across every status. There is no
  ordering to drag against yet.
- **Multiple views on Calendar and Signal** is two components with two different range models, not
  one shared control. The Calendar is a month agenda by deliberate design; Signal is a month grid.
- **Incorporate the Claude artifact Social Media Publisher into Signal** is blocked on an input this
  review does not have, and it lands on top of an architecture decision this repository has already
  made and written down.

The best release shape is a **paper-cut milestone first**, because eight of the nine paper-cuts are
independent, low-risk, and separately verifiable. Follow it with the two visual/navigation feature
cards, then treat task ordering, calendar views, and publishing as their own scoped epics.

Indicative sizes used below:

- **XS:** under half a development day
- **S:** up to about two focused development days
- **M:** about three to five development days
- **L:** about one to two weeks
- **XL:** multiple sprints or an architecture program

These are planning ranges, not delivery commitments. They assume one implementer, review, tests, and
documentation, and they include the version bump and changelog entry every merged card owes under
`AGENTS.md`.

## Important current-state findings

1. **Version 4 landed.** Calendar, Files, Import, Signal, categories, tags, task types, breadcrumbs,
   activity semantics, and the `App.tsx` split all shipped. `client/src/App.tsx` is one line now and
   the UI lives in 25 components. The conflict-hotspot warning from the Version 4 report no longer
   applies; these cards can run closer to concurrently than that sprint's could.
2. **Task notes are deliberately private.** `client/src/components/TaskDetail.tsx:299` heads the
   Notes section with the eyebrow "Private", and the Version 4 report left "should notes display, or
   remain edit-only working text" as an open decision. Bug 1 answers that question in the opposite
   direction. It is a product reversal, not a rendering defect — the card should say so.
3. **A "Dev Work" tag already exists.** It is visible on every task in the source screenshots.
   Adding a `DEV_WORK` **task type** creates two different labels with the same name and different
   meanings, in a workspace where tags and categories were split apart precisely so a label's kind
   is unambiguous.
4. **The Signal planner has no height bound, and that is the whole cell-overflow bug.**
   `.signal-day` sets `min-height: 132px` with no maximum, and `.signal-post-text` is
   `white-space: pre-wrap` with no clamp (`client/src/styles.css:3011`, `:3104`). A thousand-character
   post stretches its cell and every cell in that week's row.
5. **The truncation card and the Calendar-views card point at two different pages.** The screenshot
   for "contain items on the calendar" is `/signal`, not `/calendar`. The Calendar is an agenda, and
   `client/src/components/CalendarView.tsx:41` records why: "a month grid cell cannot hold a post
   that runs to a thousand characters." Truncation removes that objection, so these two cards are
   related — but they are still two cards on two components.
6. **A Signal post is already a `<button>`.** `.signal-post` wraps its whole body in one button that
   opens the editor (`SignalView.tsx:114`). A clickable "…" inside it would be a button inside a
   button, which is invalid and does not receive its own click. The expand affordance needs the post
   restructured, not an element added.
7. **Task `position` is scoped to a status column.** `POST /api/tasks/reorder` requires a `status`
   and writes `UPDATE tasks SET position=? WHERE id=? AND status=?` (`server/app.ts:968`). There is
   no project-wide task order for a project-page drag to write to.
8. **The project task list is ordered by status string, alphabetically.** `/api/tasks` sorts
   `ORDER BY t.status, t.position, t.updated_at DESC` (`server/repositories.ts:115`). On the board
   that is invisible because each column filters to one status. On the project page it means the
   flat list runs Backlog, Complete, In Progress, Review, To Do — alphabetical, not workflow order.
   Anyone adding drag to that list should fix or deliberately keep this first.
9. **The board's Priority filter is component state; every other filter is in the URL.**
   `Kanban.tsx:49` holds `priority` in `useState` while client, project, focus, and tags live in
   search params. A new Task-type filter has to pick a side, and the established rule in this
   codebase is that a filtered board survives a reload.
10. **The sample playbook is a repository file, not a served asset.**
    `docs/examples/campaign-playbook-import-format.xlsx` exists but nothing serves it. A download
    link needs either a new API route (with a request budget, per `server/budgets.ts`) or the file
    copied into `client/public/` and kept in step with the documented format.
11. **`/kanban` is referenced in 8 source locations and roughly 20 test and e2e locations.** Source:
    the nav item and route (`App.tsx:162`, `:280`), the breadcrumb map (`breadcrumbs.ts:46`), three
    dashboard links plus two dashboard buttons (`Dashboard.tsx:138-307`), `CalendarView.tsx:137`,
    `ProjectDetail.tsx:108`, `Projects.tsx:381`. The CSS class names (`.kanban-card`,
    `.kanban-column`) are separate, and e2e selectors depend on them.
12. **`CalendarView.tsx:137` links to `/kanban?project=…&task=…`, and nothing reads `task`.** The
    board never opens that task. Pre-existing, unrelated to Version 5, and cheapest to fix while
    that line is being edited for the slug rename anyway.
13. **The Settings blank space is a grid span.** `.settings-card:first-child { grid-row: span 2 }`
    (`client/src/styles.css:1672`) makes the Drive card occupy two rows regardless of its content,
    so it stretches to whatever the right column is tall.
14. **Publishing is already decided and documented.** `docs/publishing-integration.md` records the
    decision — Post Bridge first, behind a single `PublishProvider`, no dual-write, delivery state in
    its own table, `SignalStatus.PUBLISHED` never set by a publisher — as card C19b (#76),
    "decided, not implemented." (#76 was the *spike* and is closed; the implementation card has never
    been filed.)
15. **The Social Media Publisher artifact has since been retrieved, and it contradicts that record
    on seven points.** Extracted 2026-08-13 into `docs/social-media-publisher-artifact.md`. The
    largest: the artifact publishes through a **claude.ai MCP connector**, holding no API key at all,
    where the record specifies a server-side bearer token against `api.post-bridge.com/v1`. It also
    models media as public URLs — which is what the record's four-channel ceiling was waiting on —
    and reveals a **second publishing path already in use**, a local Buffer Bridge covering TikTok,
    Bluesky, and Threads. Item 14 below is no longer blocked; see `VERSION_5_CARDS.md` C45–C48.

## Feasibility by sprint item

### Bugs

| Item | Feasibility / size | Recommendation and acceptance boundary |
|---|---:|---|
| Notes do not render onto the task card | High / S | Decide first whether notes stay private (finding 2). If they become visible, render them on `KanbanCard` distinctly from the description — the card already renders `task.description` at `KanbanCards.tsx:93` and the two must not read as one paragraph. Clamp the length; notes are working text and can run long. Change the "Private" eyebrow in the detail modal in the same branch, or the app makes two contradictory promises about the same field. |

### Paper-cuts

| Item | Feasibility / size | Recommendation and acceptance boundary |
|---|---:|---|
| Add "Dev Work" to Task types | High / XS | `TASK_TYPES` and `TASK_TYPE_LABEL` only; `task_type` is an unconstrained `TEXT` column, so no migration. Decide whether it gets a `TASK_CHECKLIST_TEMPLATES` entry — every other type except `OTHER` has one. Resolve the collision with the existing "Dev Work" tag (finding 3): rename one, or state in the card that the duplication is intended. |
| Add Task types to filter bar on Status page | High / S | Put it in the URL, not component state, and consider moving Priority there in the same card (finding 9). Include an "Any type" default and a "No type" option — untyped tasks predate the field and are normal. Extend `Kanban.task-type.test.tsx`. |
| Reorder Task details modal (Checklist > Notes > Tags) | High / XS-S | Section order only; each section is already its own component. The wording omits Dependencies — decide where it lands (recommendation: last, as today). Assertion order in `TaskDetail.test.tsx` and `TaskDetail.dependencies.test.tsx` may need updating. |
| Add 10px padding between Description text and Description box | High / XS | Scope the rule to `.inline-edit label`. That form is not `.form`, so it misses the `gap: 6px` at `styles.css:1867` and inherits nothing — this is why the gap is zero. Scoping it there also fixes Notes, which uses the same editor, and touches no other form in the app. |
| Add "Download sample Playbook here" link to Import page | High / S-M | The only paper-cut with a server dimension (finding 10). Prefer a served route over a duplicated file, so the download and `docs/campaign-playbook-import-format.md` cannot drift. Set `Content-Type` and `Content-Disposition`, give it a request budget, and add a test that the served bytes are the documented workbook. |
| Remove blank space at bottom of Drive stage in Settings | High / XS | Drop or condition the `grid-row: span 2` (finding 13), or set the layout to `align-items: start`. Check the `styles.css:2491` responsive override in the same pass, and verify at both the connected and disconnected Drive states — they are very different heights. |
| Contain calendar items to a fixed square, truncate with a clickable "…" | High / M | This is the Signal planner, not the Calendar (finding 5). Bound `.signal-day`, clamp `.signal-post-text` to a fixed line count, and restructure the post so the expand control is a sibling of the edit button rather than nested inside it (finding 6). Expanded state must be per-post, must not resize its neighbours, and must be reachable and dismissable by keyboard. |
| Make Project text on Task Detail modal clickable to the project | High / S | `TaskDetail.tsx:202` renders `{clientName} · {projectName}` as one span. Decide whether the client half links too — both ids are on the task. Navigating from a modal must close it; leaving a dialog mounted over a new route is the failure mode to test for. |
| Update the slug from `kanban` to `status` | High / S-M | Mechanically simple, broad blast radius (finding 11). Keep a redirect from `/kanban` — bookmarks and the last-project link exist. Decide explicitly whether CSS class names change too; if they do, `e2e/critical-flow.spec.ts` and `e2e/dashboard-to-board.spec.ts` change with them, and that decision belongs in the card rather than in review. Fix the dead `task` param while editing `CalendarView.tsx:137` (finding 12). |

Eight of these nine are independent. Only the Signal truncation card overlaps another item — it
shares `SignalView.tsx` with the Signal half of the views card below, and should merge first.

### Feature requests

| Item | Feasibility / size | Recommendation and acceptance boundary |
|---|---:|---|
| Draggable tasks on Projects stage | Feasible, model-dependent / M | Not a UI card. Decide the ordering model first (findings 7 and 8): either drag reorders only within a status group, reusing `/api/tasks/reorder` as it stands, or tasks gain a project-scoped order and a second endpoint, and the two orderings must then be reconciled where the board and the project page disagree. Fix or deliberately keep the alphabetical status grouping in the same card. Reuse the Projects tile pattern — grip-only listeners, a keyboard position `<select>`, and rows that stay links (`Projects.tsx:319`). |
| Visual difference between card status chip and stage box | High / S | `.status-label` is one style for all five project statuses (`styles.css:1148`). Add per-status variants to the chip and a matching treatment on the tile. `AGENTS.md` requires colour to be paired with text or an icon — the chip already carries its word, so keep it. Validate contrast for every status in both the tile and chip contexts. |
| Multiple views on Calendar and Signal (Today, Week, Month) | Feasible / M-L | Two components, one vocabulary. Both APIs already take arbitrary `from`/`to` ranges, so no server work is required for the ranges themselves. Put the view in the URL beside `month` so a view survives a reload. Signal gains a Today control it does not have. Decide what "Today" shows on the Calendar — one day of an agenda is a short page — and whether Week on Signal keeps the seven-column grid or becomes a list. Ship one page first and copy the settled control to the second. |
| Incorporate Claude artifact Social Media Publisher into Signal | Feasible, unblocked 2026-08-13 / L–XL | **Superseded by finding 15.** The artifact has been retrieved and extracted to `docs/social-media-publisher-artifact.md`. It is not portable as written — its transport is a claude.ai connector a Node server neither has nor needs, and its timezone handling is worse than the record's. What *is* portable is its platform capability table, its preflight rules, and its error taxonomy, all proven against the live API. Split into four cards: the Signal link defect it exposed (independent, ship now), reconciling the decision record, media on `SignalPost`, then the implementation. See `VERSION_5_CARDS.md` C45–C48. |

## Recommended release cadence

Repository policy is unchanged: every merged card ships a version bump, the first card closed in a
milestone takes the minor and later cards take patches, and the number is settled at merge time, so
branches stay `<type>/<issue>-<slug>`. `npm run check:version-bump` is the gate. Each card also owes
a `CHANGELOG.md` entry in its own branch.

Keep the twice-weekly release train. The waves below define sequencing, not bundled versions.

### Wave 1: Paper-cuts (about 4-5 working days)

1. Padding, Settings blank space, "Dev Work" type — the three XS cards, mergeable in any order.
2. Task-type filter on the Status page.
3. Task details section reorder.
4. Clickable project text on the task detail modal.
5. Sample playbook download.
6. Signal cell containment and truncation.
7. Slug rename last in the wave, so it rebases over the other cards' link edits rather than under them.

Release gate per card: unit and integration tests, typecheck, lint, format check, production build,
`check:version-bump`, and coverage floors held. Run the e2e suite on the slug card specifically — it
is the one that can break `e2e/` selectors and routes.

### Wave 2: Visual status and the notes decision (about 2-3 days)

1. Answer the notes-privacy question, then ship the task-card notes card.
2. Per-status chip and tile treatment, with contrast checked for all five statuses.

### Wave 3: Ordering and views (about 1-2 weeks)

1. Decide the task ordering model, then ship draggable project tasks.
2. Calendar and Signal view switching, one page at a time.

### Wave 4: Publishing

The artifact is in hand, so this is no longer an unscoped epic. One card ships immediately and
independently — the X link matcher defect in shipped Signal code, which publishes nothing and fixes
content that is going out wrong today. The other three run in order: reconcile the decision record
against what the artifact proves, model media on `SignalPost`, then implement `PublishProvider`.
Cards C45–C48 in `VERSION_5_CARDS.md`.

Do not start Wave 3's Signal work until the Wave 1 truncation card has merged; they share the same
component and the same cells.

## Additional improvements to consider

1. **Give the filter bar one home for its state.** Moving Priority into the URL while adding the
   Task-type filter removes the only exception, and makes every board view linkable.
2. **Order the project task list by workflow, not alphabet.** Finding 8 is invisible on the board
   and wrong on the project page, and it is cheapest to fix inside the drag card.
3. **Make the board honour a `task` query parameter.** `CalendarView` already links with one; making
   it open that task's detail modal turns a dead link into the Calendar's most useful action.
4. **Settle the label vocabulary before adding "Dev Work".** Tags label tasks and categories label
   projects, both deliberately. A task *type* named the same as a task *tag* undoes that clarity for
   the one label the user looks at most.
5. **Decide the truncation limit once and share it.** If the Calendar ever gains a grid view, it will
   need the same clamp. A shared constant beats two stylesheets agreeing by coincidence.
6. **Add a redirect test for the slug rename.** A route rename is exactly the change that passes
   every unit test and breaks a bookmark, and the redirect is the only part of it a test can prove.
7. **Serve the sample workbook from one source of truth.** Copying the `.xlsx` into `client/public/`
   is faster now and guarantees drift later, because `AGENTS.md` requires the format document to
   change whenever the importer does — and a copied file will not be in that branch.
8. **Record the notes-visibility reversal in the changelog explicitly.** A field the app called
   private becoming visible on a card is a user-facing behaviour change, and the changelog rule asks
   for what changed for someone using the app.

## Decisions required before cards are written

1. Do task notes stay private, or become visible on the task card? If visible, does the "Private"
   eyebrow in the detail modal change with it?
2. Does the new `DEV_WORK` task type coexist with the existing "Dev Work" tag, or does one get
   renamed?
3. Does `DEV_WORK` get a default checklist template, and if so, what is on it?
4. Where do Dependencies sit after the Task details reorder — last, or somewhere in the new sequence?
5. Does the Task-type filter live in the URL, and does Priority move there with it?
6. On the Task Detail modal, is the client name clickable as well as the project name?
7. Does the slug rename extend to CSS class names and e2e selectors, or only to the route?
8. Is the `/kanban` redirect permanent, or is it removed after an agreed period?
9. Does dragging a task on the Projects stage reorder within its status group, or does a
   project-scoped task order get introduced?
10. Does the project task list stay grouped alphabetically by status, or move to workflow order?
11. What does the "Today" view show on the Calendar, and does Signal's Week view keep the grid?
12. ~~Is "Social Media Publisher" an interface to port, or the publishing capability itself — and can
    the artifact be supplied?~~ **Answered 2026-08-13.** The artifact was retrieved and extracted; it
    is the publishing capability, and it is not portable as written. Superseded by questions 13–15.
13. Does the publisher keep the record's server-side API key, now that a working connector-based
    integration exists? (Recommendation: yes — a local Express server is not subject to the
    artifact's connectors-only restriction.)
14. Does Buffer stay a separate local bridge for TikTok, Bluesky, and Threads, or does the app take
    those channels on? The record's own trigger to revisit the Post-Bridge-only decision has already
    fired.
15. Does modelling media on `SignalPost` — public URLs only, no upload — happen in Version 5, which
    would raise publishing from four channels to nine?

## Verification performed

- `npm.cmd test`: **614/614 passed**, 56 test files, 9.6s
- `npm.cmd run typecheck`: **passed**
- `npm.cmd run lint`: **passed**
- `npm.cmd run build`: **passed** (2,146 modules, 423.01 kB JS / 45.54 kB CSS)

`npm run test:e2e` was not run for this review. No application, database, or Dropbox data was changed.
This report is the only repository change.

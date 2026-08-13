# Version 5 — Cards

### Ready-to-file issues for the Version 5 sprint

**Prepared** 13 August 2026
**Written against** `main` `b8f2e3a`, `package.json` 4.0.0 — every file:line citation below was re-checked against this commit
**Source** `Version 5.docx` (1 bug, 9 paper-cuts, 4 feature requests), `VERSION_5_FEASIBILITY_REPORT.md`, `docs/social-media-publisher-artifact.md`
**Convention** `AGENTS.md` — one card per branch, `<type>/<issue>-<slug>`, one version bump per merged card, first close in a milestone takes the minor
**Board** Command Center v5 (`PVT_kwHOEs58Js4BgQHL`)

Eighteen cards, C31–C48, continuing the numbering from Version 4 (which ended at C30/#112).

**Filed 13 August 2026 as #133–#150**, across four milestones, all eighteen on the Command Center v5
board. Every branch name below carries its real issue number, so a branch can be cut without looking
anything up.

---

## 0. Notes

**Sizes are on the repository's label scale, not the report's.** `VERSION_5_FEASIBILITY_REPORT.md`
sizes in development days for release planning. The `size-*` labels mean hours: `size-s` under 1,
`size-m` 1–3, `size-l` 4–8, `size-xl` 8–12, `size-xxl` a day or more. The cards below carry the label
scale. Where a card looks smaller here than in the report, that is the two scales, not a change of
scope.

`size-xl` and `size-xxl` were added on 13 August 2026 and `size-l` was narrowed from "4 hours or
more" to 4–8. The old top label lumped a CSS restructure together with a two-table provider
integration; eight cards below are sized against the finer scale, and every one of them moved up
rather than down.

**Waves replace Version 4's Stages.** Milestones, created as #14–#17:

| Milestone | Cards | Theme |
| --- | --- | --- |
| `Wave 1 — Paper cuts` | C31–C39 | Nine independent contained fixes |
| `Wave 2 — Status visibility` | C40–C41 | What a card and a tile say about state |
| `Wave 3 — Ordering and views` | C42–C44 | Task order, and Today/Week/Month |
| `Wave 4 — Publishing` | C45–C48 | Signal's link defect, then the publish path |

**Four items in the source document are not one card each.**

- *"Contain items on the calendar…"* is the **Signal** planner, not the Calendar page. Its screenshot
  is `/signal`. C38 is scoped there.
- *"Multiple views on Calendar and Signal"* is two components with two range models, so it is two
  cards (C43, C44) with one shared vocabulary settled in the first.
- *"Incorporate Claude artifact Social Media Publisher into Signal"* is not portable as written. The
  artifact reaches Post Bridge through a **claude.ai MCP connector**, which a Node server neither has
  nor needs; and `docs/publishing-integration.md` already decided a different transport. It becomes
  C46 (reconcile the record), C47 (media, the stated prerequisite), and C48 (the implementation).
  The artifact's genuinely portable asset — the platform capability table and preflight rules — is
  carried into C48's scope.
- The artifact extraction also surfaced a **defect in shipped Signal code** unrelated to publishing.
  That is C45, and it does not wait for anything.

**Two product decisions must be answered before their cards start**, and both are recorded on the
issue rather than left to review: C40 (do notes stay private?) and C42 (does a project-page drag
reorder within a status, or introduce a project-scoped order?).

---

## Card index

| # | Issue | Card | Type | Labels | Wave |
|---|---|---|---|---|---|
| C31 | #133 | Description label and its box get their gap back | fix | `tier-2-ui` `size-s` | 1 |
| C32 | #134 | The Settings Drive card stops stretching | fix | `tier-2-ui` `size-s` | 1 |
| C33 | #135 | "Dev Work" joins the task types | feat | `tier-2-ui` `size-s` | 1 |
| C34 | #136 | Task type on the Status filter bar | feat | `tier-2-ui` `size-m` | 1 |
| C35 | #137 | Task details reads Checklist, Notes, Tags | feat | `tier-2-ui` `size-s` | 1 |
| C36 | #138 | The project line on Task details is a link | feat | `tier-2-ui` `size-m` | 1 |
| C37 | #139 | The Import page offers the sample playbook | feat | `tier-2-ui` `size-l` | 1 |
| C38 | #140 | Signal day cells contain their posts | fix | `tier-2-ui` `size-l` | 1 |
| C39 | #141 | `/kanban` becomes `/status` | chore | `chore` `size-l` | 1 |
| C40 | #142 | Task notes reach the card | fix | `bug` `size-s` `blocked` | 2 |
| C41 | #143 | A project tile shows which status it is in | feat | `tier-2-ui` `size-m` | 2 |
| C42 | #144 | Tasks are draggable on the project page | feat | `tier-3-schema` `size-xl` | 3 |
| C43 | #145 | The Calendar shows Today, Week, or Month | feat | `enhancement` `size-xl` | 3 |
| C44 | #146 | The Signal planner takes the same three views | feat | `enhancement` `size-l` | 3 |
| C45 | #147 | Signal's link matcher catches bare domains | fix | `bug` `size-s` | 4 |
| C46 | #148 | Reconcile the publishing record with the shipped artifact | docs | `docs` `size-m` | 4 |
| C47 | #149 | Media on `SignalPost` | feat | `tier-3-schema` `size-xl` | 4 |
| C48 | #150 | `PublishProvider`, preview, and confirmed submit | feat | `tier-3-schema` `size-xxl` `blocked` | 4 |

---

# Wave 1 — Paper cuts

Nine cards, eight of them independent. Merge order is free except that **C39 goes last** — it edits
the same links C36 and C43 touch, and rebasing a rename over them is cheaper than the reverse. C38
must merge before C44.

---

## C31 — Description label and its box get their gap back

**Type / branch:** `fix/133-inline-editor-label-gap`
**Size:** S · **Labels:** `tier-2-ui` `size-s`
**Depends on:** nothing
**Resolves:** Version 5 paper-cut 4

### Problem

In the Task details inline editor the word "Description" sits flush against the top of its textarea.
`InlineTextEditor` renders `<label>{label}<textarea/></label>` inside `<form className="inline-edit">`
(`client/src/components/InlineEditors.tsx:38-49`). That form is **not** `.form`, so it never picks up
the `gap: 6px` on `.form label, .root-form label` (`client/src/styles.css:1867-1874`), and no other
rule sets one. The gap is zero by omission rather than by choice.

### Scope

One scoped rule for `.inline-edit label` — `display: flex; flex-direction: column; gap: 10px` — and
nothing wider.

### Out of scope — do not build here

- Touching `.form label`. It is correct at 6px and is inherited by every form in the app.
- Any other spacing on the Task details modal.

### Acceptance criteria

- [ ] The Description label clears its textarea by 10px.
- [ ] Notes, which uses the same editor, gets the same gap.
- [ ] No other form in the app changes: Settings, Task form, Project form, Client form, and the
      Signal editor render identically before and after.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: open a task, click Add a
description, compare against the Settings branding form.

---

## C32 — The Settings Drive card stops stretching

**Type / branch:** `fix/134-settings-drive-card-height`
**Size:** S · **Labels:** `tier-2-ui` `size-s`
**Depends on:** nothing
**Resolves:** Version 5 paper-cut 6

### Problem

The Google Drive card runs to a large blank area beneath its content.
`.settings-card:first-child { grid-row: span 2 }` (`client/src/styles.css:1672-1674`) makes it occupy
two grid rows whatever it contains, so it stretches to whatever the right column happens to be tall.

### Scope

Either drop the span and let the card size to its content, or set the layout to `align-items: start`
— whichever leaves the two-column balance intact at desktop width. Check the responsive override at
`client/src/styles.css:2491` in the same pass.

### Out of scope — do not build here

- Re-ordering or re-grouping the Settings cards.

### Acceptance criteria

- [ ] No blank region below the Drive card at desktop width.
- [ ] Verified in **both** Drive states — disconnected (short) and connected with a root folder set
      (tall) — since they differ by several hundred pixels.
- [ ] Verified with the credentials warning showing and hidden.
- [ ] The single-column responsive layout is unchanged.
- [ ] `client/src/Settings.branding.test.tsx` and `Settings.categories.test.tsx` pass unmodified.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: `/settings` at 1440px and
at 800px, Drive connected and disconnected.

---

## C33 — "Dev Work" joins the task types

**Type / branch:** `feat/135-dev-work-task-type`
**Size:** S · **Labels:** `tier-2-ui` `size-s`
**Depends on:** nothing
**Resolves:** Version 5 paper-cut 1

### Problem

`TASK_TYPES` (`shared/types.ts:8-17`) has eight values and none of them is development work, which is
what most of this workspace's own tasks are.

### Scope

- Add `DEV_WORK` to `TASK_TYPES` and a label to `TASK_TYPE_LABEL`
  (`client/src/components/ui-shared.ts:29`).
- **No migration.** `task_type` is an unconstrained `TEXT` column (`server/db.ts:29`) and validation
  is Zod-only at the boundary (`server/app.ts:283-289`), so the value needs no schema change.
- Decide and record whether it gets a `TASK_CHECKLIST_TEMPLATES` entry. Every type except `OTHER`
  has one; a type with no template is a deliberate choice, not an omission.

### The name collision, which must be settled on this card

A **tag** named "Dev Work" already exists in this workspace and is attached to most tasks — it is
visible in every Version 5 screenshot. Tags label tasks and categories label projects, split apart
deliberately so a label's kind is unambiguous (`AGENTS.md` §Conventions). A task *type* sharing a
name with a task *tag* undoes that for the label the user reads most often. Either rename one, or
state on the issue that the duplication is intended and why.

### Out of scope — do not build here

- Any change to how task types are stored, validated, or filtered. Filtering is C34.

### Acceptance criteria

- [ ] `DEV_WORK` selectable on the task form and rendered by `TaskTypeBadge`.
- [ ] `shared/types.test.ts` covers the new value.
- [ ] The template decision is recorded in the issue and reflected in code.
- [ ] The tag collision is resolved or explicitly accepted, in writing.
- [ ] Existing typed and untyped tasks are unaffected.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

## C34 — Task type on the Status filter bar

**Type / branch:** `feat/136-status-board-task-type-filter`
**Size:** M · **Labels:** `tier-2-ui` `size-m`
**Depends on:** C33 (so the new type appears in the control on arrival)
**Resolves:** Version 5 paper-cut 2

### Problem

The board filter bar carries Client, Project, Priority, and Focus
(`client/src/components/Kanban.tsx:169-217`) and no way to filter by task type, even though the type
is rendered on every card.

### Scope

- A Task type select in the filter bar, with an **"Any type"** default and a **"No type"** option —
  untyped tasks predate the field and are normal, so they need to be findable rather than merely
  not-excluded.
- **Put it in the URL.** Client, project, focus, and tags are all search params
  (`Kanban.tsx:45-53`); a filtered board is meant to survive a reload and be handed over as a link.
- **Move Priority into the URL in the same card.** It is the one filter still in component state
  (`Kanban.tsx:49`), and this card is the only time the filter bar will be open. Leaving it behind
  makes the exception permanent.

### Out of scope — do not build here

- Any change to the tag filter or the search box.
- Filtering task type anywhere other than the Status board.

### Acceptance criteria

- [ ] Selecting a type narrows the board, and combines with client, project, priority, focus, tags,
      and search rather than replacing any of them.
- [ ] "No type" shows exactly the tasks with no `taskType`.
- [ ] Both new params survive a reload and reproduce the same board from a pasted URL.
- [ ] The visible-task count in the page header agrees with the board.
- [ ] `client/src/Kanban.task-type.test.tsx` extended; `Kanban.deadlines.test.tsx` and
      `Kanban.tags.test.tsx` pass unmodified.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: filter, reload, confirm the
board returns identical.

---

## C35 — Task details reads Checklist, Notes, Tags

**Type / branch:** `feat/137-task-detail-section-order`
**Size:** S · **Labels:** `tier-2-ui` `size-s`
**Depends on:** nothing
**Resolves:** Version 5 paper-cut 3

### Problem

The modal orders its sections Tags → Checklist → Notes → Dependencies. The requested order is
**Checklist → Notes → Tags**: progress first, working text next, labels last.

### Scope

Reorder the section components in `client/src/components/TaskDetail.tsx`. Each section is already its
own component, so this is composition order and not a rewrite.

**Dependencies is not mentioned in the request.** Recommendation: leave it last, where it is. Record
the choice on the issue either way — an unstated ordering decision is the thing that gets re-litigated
in review.

### Out of scope — do not build here

- Any change to what a section contains, or to the "Private" eyebrow on Notes. That eyebrow belongs
  to C40 and must not be touched twice.

### Acceptance criteria

- [ ] Sections render Checklist, Notes, Tags, then Dependencies.
- [ ] Every section keeps its heading, eyebrow, and behaviour.
- [ ] Tab order follows the visual order.
- [ ] `TaskDetail.test.tsx` and `TaskDetail.dependencies.test.tsx` updated where they assert order,
      and passing.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

## C36 — The project line on Task details is a link

**Type / branch:** `feat/138-task-detail-project-link`
**Size:** M · **Labels:** `tier-2-ui` `size-m`
**Depends on:** nothing
**Resolves:** Version 5 paper-cut 8

### Problem

Task details prints `{clientName} · {projectName}` as plain text
(`client/src/components/TaskDetail.tsx:202`). Both ids are on the task, and the project it names is
the most likely next destination.

### Scope

- Make the project name a link to `/projects/:id`.
- **Navigating must close the modal.** A dialog left mounted over a new route is the failure this
  card is most likely to ship; it needs a test, not a manual check.
- Decide whether the client name links to `/clients/:id` too. Both ids are available and the answer
  is a one-line difference — record it on the issue rather than discovering it in review.

### Out of scope — do not build here

- Linking project or client names anywhere else, including the Kanban card
  (`KanbanCards.tsx:80-82`).

### Acceptance criteria

- [ ] Clicking the project name lands on that project's page with no modal on screen.
- [ ] Keyboard activation does the same, and focus lands somewhere sensible on the new page.
- [ ] The link renders as a link — not a button styled as text — and shows a visible focus ring.
- [ ] A task whose project was deleted underneath the modal does not produce a dead link.
- [ ] The client-name decision is recorded and implemented.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: open a task from the
dashboard, the board, and the project page; follow the link from each.

---

## C37 — The Import page offers the sample playbook

**Type / branch:** `feat/139-import-sample-playbook-download`
**Size:** L · **Labels:** `tier-2-ui` `size-l`
**Depends on:** nothing
**Resolves:** Version 5 paper-cut 5

### Problem

`docs/examples/` holds a sample workbook and the Import page only mentions it in prose
(`client/src/components/ImportView.tsx:96-99`). Nothing serves it, so the file a first-time importer
needs is reachable only by opening the repository.

### Scope

- A **Download sample playbook** link in the Import page header, beside *Import a playbook*.
- Serve the workbook from the API rather than duplicating it into `client/public/`. `AGENTS.md`
  requires `docs/campaign-playbook-import-format.md` to change whenever the importer does; a copied
  binary will not be in that branch, and the two will drift the first time the format moves.
- Set `Content-Type` and `Content-Disposition`, give the route a budget in `server/budgets.ts` the
  way the import and Drive routes already carry one, and serve one fixed path — no parameter, so
  there is no traversal surface to get wrong.

### Out of scope — do not build here

- Any change to the import format, the importer, or the format document.
- Serving anything else out of `docs/`.

### Acceptance criteria

- [ ] The link downloads a file that opens as a valid workbook.
- [ ] A test asserts the served bytes are `docs/examples/`'s workbook, so a moved or renamed file
      fails the build rather than the user's download.
- [ ] The route carries a budget and is covered by `server/budgets.test.ts`.
- [ ] Correct filename and MIME type in the browser's download.
- [ ] Works in the production build, where the server also serves `dist/client`.
- [ ] `client/src/Import.test.tsx` covers the link.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, then `npm start` and download from
the production build.

---

## C38 — Signal day cells contain their posts

**Type / branch:** `fix/140-signal-day-cell-containment`
**Size:** L · **Labels:** `tier-2-ui` `size-l`
**Depends on:** nothing. **Merge before C44.**
**Resolves:** Version 5 paper-cut 7

### Problem

A Signal day cell grows to fit whatever is in it, and campaign posts run to a thousand characters.
`.signal-day` sets `min-height: 132px` with no maximum (`client/src/styles.css:3011-3017`) and
`.signal-post-text` is `white-space: pre-wrap` with no clamp (`:3104-3110`). One long post stretches
its cell and every cell in that week's row, which is the whole of the reported symptom.

### Scope

- Bound the cell and clamp the post text to a fixed number of lines, ending in an ellipsis.
- An **expand affordance that opens the full text in place**, per post, without resizing its
  neighbours.

### The structural problem this card has to solve first

`.signal-post` is already a `<button>` wrapping the entire post body
(`client/src/components/SignalView.tsx:114-124`); clicking it opens the editor. A clickable "…"
inside it would be a button inside a button — invalid, and it never receives its own click. The post
must be restructured so the expand control is a **sibling** of the edit control, not a descendant.
Settle that structure before writing CSS.

### Out of scope — do not build here

- View switching. That is C44.
- The Calendar page, which is an agenda and has no cells (`CalendarView.tsx:41`).
- Any change to what a post stores.

### Acceptance criteria

- [ ] Every cell in a month is the same height regardless of post length, including a month
      containing the 1,000-character campaign posts.
- [ ] Truncated text ends in a visible ellipsis; expanding shows the full text and collapses again.
- [ ] Expanding one post moves no other cell.
- [ ] Expand and edit are separately reachable by keyboard, separately labelled for screen readers,
      and neither triggers the other.
- [ ] Editing a post still opens the editor from the same place it does today.
- [ ] `client/src/Signal.test.tsx` covers truncation, expansion, and that edit still opens.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: `/signal` on August 2026,
which holds the long posts; keyboard-only pass over one populated cell.

---

## C39 — `/kanban` becomes `/status`

**Type / branch:** `chore/141-status-slug-rename`
**Size:** L · **Labels:** `chore` `size-l`
**Depends on:** nothing. **Merge last in Wave 1** — it rebases over C36's and C43's link edits.
**Resolves:** Version 5 paper-cut 9

### Problem

The page is called Status everywhere in the UI and its route is `/kanban`. Hovering the nav item
shows the old word.

### Scope

Rename the route and every internal reference. Eight source sites, verified at `b8f2e3a`:

| File | Line |
| --- | --- |
| `client/src/components/App.tsx` | 162 (nav), 280 (route) |
| `client/src/components/breadcrumbs.ts` | 46 |
| `client/src/components/Dashboard.tsx` | 138, 139, 205, 248, 307 |
| `client/src/components/CalendarView.tsx` | 137 |
| `client/src/components/ProjectDetail.tsx` | 108 |
| `client/src/components/Projects.tsx` | 381 |

Plus roughly twenty test and e2e references.

- **Keep a redirect from `/kanban`**, preserving the query string. Bookmarks exist, and every
  dashboard tile has been linking there for four versions.
- **Fix the dead `task` parameter while here.** `CalendarView.tsx:137` links to
  `/kanban?project=…&task=…` and the board never reads `task` (`Kanban.tsx:45-53`), so the Calendar's
  most useful link lands on an unfiltered board. Either make the board open that task's detail modal,
  or drop the parameter — but do not carry a known-dead parameter through a rename.

### The decision this card must state up front

**Does the rename extend to CSS class names?** `.kanban-board`, `.kanban-column`, and `.kanban-card`
are used as selectors by `e2e/critical-flow.spec.ts` and `e2e/dashboard-to-board.spec.ts`. Renaming
them is defensible and roughly doubles the diff. Decide on the issue, not in review.

### Out of scope — do not build here

- Any behaviour change to the board itself.

### Acceptance criteria

- [ ] `/status` serves the board; the nav item, breadcrumb, and every internal link point at it.
- [ ] `/kanban` redirects to `/status` **with its query string intact** — `/kanban?filter=today`
      lands on a board filtered to today. A test asserts this; it is the only part of the change a
      test can prove and the part most likely to be missed.
- [ ] The `task` parameter is either honoured or removed, with the choice recorded.
- [ ] The CSS-class decision is recorded and applied consistently.
- [ ] `npm run test:e2e` passes.
- [ ] No occurrence of `kanban` remains outside the redirect and any deliberately-kept class names.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, **and `npm run test:e2e`** — this
is the one Wave 1 card that can break e2e routes and selectors.

---

# Wave 2 — Status visibility

Two cards. C40 cannot be filed until its question is answered.

---

## C40 — Task notes reach the card

**Type / branch:** `fix/142-task-notes-on-card`
**Size:** S · **Labels:** `bug` `size-s` `blocked`
**Depends on:** a product decision — see below. File the decision on the issue before starting.
**Resolves:** Version 5 bug 1

### Problem, and why it is not only a rendering bug

`KanbanCard` renders `task.description` (`client/src/components/KanbanCards.tsx:93`) and never
`task.notes`. The field exists on `Task` (`shared/types.ts:190`) and is editable in the detail modal.

**But notes are currently private on purpose.** The detail modal heads the section with the eyebrow
"Private" (`client/src/components/TaskDetail.tsx:299`), and Version 4's report left "should notes
display, or remain edit-only working text" as an open question. Showing them on the card answers that
question in the opposite direction. That is a product reversal, and the card has to say so.

### The decision required before this is filed

Do notes stay private, or become visible on the card? If visible, the "Private" eyebrow changes in
the same branch — otherwise the app makes two contradictory promises about one field.

### Scope, assuming the decision is "visible"

- Render notes on the card, **visually distinct from the description**. The two must not read as one
  paragraph; description is the client-facing text and notes are working text.
- Clamp the length. Notes run long by design.
- Change the "Private" eyebrow in `TaskDetail.tsx` to match.
- Record the behaviour change in `CHANGELOG.md` in plain user terms — a field the app called private
  becoming visible is exactly what the changelog rule is for.

### Out of scope — do not build here

- Editing notes from the card.
- Any change to section order. That is C35, and the two must not both touch the eyebrow.

### Acceptance criteria

- [ ] Notes render on the card, distinguishable from the description without relying on colour alone.
- [ ] Long notes are clamped and do not change card height unpredictably.
- [ ] A task with notes and no description, and one with both, both render correctly.
- [ ] The detail modal no longer calls the field private.
- [ ] `CHANGELOG.md` states the change in user-facing terms.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

## C41 — A project tile shows which status it is in

**Type / branch:** `feat/143-project-status-visual-distinction`
**Size:** M · **Labels:** `tier-2-ui` `size-m`
**Depends on:** nothing
**Resolves:** Version 5 feature request 2

### Problem

Every project tile styles its status the same way. `.status-label`
(`client/src/components/Projects.tsx:333`, styled at `client/src/styles.css:1148`) is one class for
all five of `PLANNING`, `ACTIVE`, `ON_HOLD`, `COMPLETE`, and `ARCHIVED`, so a grid of tiles gives no
signal about state until each word is read.

### Scope

- Per-status variants on the chip, and a matching treatment on the tile itself.
- **Colour never carries it alone.** `AGENTS.md` requires visual status colours to be paired with
  text or an icon; the chip already carries its word, so keep the word and add to it.
- Check contrast for all five statuses in both contexts, using the existing `shared/contrast.ts`
  helpers rather than a new set of thresholds.

### Out of scope — do not build here

- The Kanban card's status dot, which is a different vocabulary (task status, not project status).
- Any change to the set of project statuses.

### Acceptance criteria

- [ ] All five statuses are distinguishable at a glance in a mixed grid.
- [ ] Each remains distinguishable with colour removed — greyscale screenshot, or the stylesheet's
      colours neutralised.
- [ ] Every status/context pair meets AA contrast.
- [ ] The archived state stays visually recessive relative to active work.
- [ ] `client/src/Projects.test.tsx` and `Projects.categories.test.tsx` pass unmodified.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: `/projects` with at least
one project in each status.

---

# Wave 3 — Ordering and views

Three cards. C42 needs its model settled first. C43 sets the vocabulary C44 copies.

---

## C42 — Tasks are draggable on the project page

**Type / branch:** `feat/144-project-task-ordering`
**Size:** XL · **Labels:** `tier-3-schema` `size-xl`
**Depends on:** the ordering decision below
**Resolves:** Version 5 feature request 1

### Problem, which is a data-model problem and not a UI one

The project page lists tasks flat (`client/src/components/ProjectDetail.tsx:134-148`) and there is no
order for a drag to write to.

- **`position` is scoped to a status column.** `POST /api/tasks/reorder` requires a `status` and
  writes `UPDATE tasks SET position=? WHERE id=? AND status=?` (`server/app.ts:968`). A flat
  cross-status list has no position space of its own.
- **The list is ordered by status string, alphabetically.** `/api/tasks` sorts
  `ORDER BY t.status, t.position, t.updated_at DESC` (`server/repositories.ts:115`), and `BACKLOG`,
  `COMPLETE`, `IN_PROGRESS`, `REVIEW`, `TODO` is alphabetical, not workflow order. Invisible on the
  board because each column filters to one status; plainly wrong on a flat list.

### The decision required before this is filed

**Either** drag reorders only *within* a status group, reusing `/api/tasks/reorder` unchanged and
grouping the list by status with headings — smaller, consistent with the board, and the recommended
answer; **or** tasks gain a project-scoped order, which means a migration, a second endpoint, and a
stated rule for what happens when the board's order and the project page's order disagree.

Whichever is chosen, **fix or deliberately keep the alphabetical grouping in this card.** It is
cheapest here and confusing everywhere else.

### Scope

Follow the pattern the Projects grid already proves (`client/src/components/Projects.tsx:319-425`):
drag listeners on a grip only — never the whole row, which is a navigation target — plus a keyboard
position `<select>` carrying the same semantics, and rows that remain activatable.

### Out of scope — do not build here

- Any change to the Status board's ordering or to `/api/tasks/reorder`'s existing contract.
- Drag on the dashboard's task lists.

### Acceptance criteria

- [ ] Reordering persists across a reload.
- [ ] The Status board's order is unchanged by a project-page drag, or the disagreement rule is
      implemented and documented — whichever the decision was.
- [ ] Keyboard reordering works without a pointer and is announced.
- [ ] Rows still open the task detail modal; dragging never navigates.
- [ ] The status grouping question is resolved, and `server/repositories.test.ts` covers the order.
- [ ] If a migration is involved: additive, idempotent, and verified against a populated copy of a
      real `command-center.db`, not a fresh seed.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

---

## C43 — The Calendar shows Today, Week, or Month

**Type / branch:** `feat/145-calendar-view-switching`
**Size:** XL · **Labels:** `enhancement` `size-xl`
**Depends on:** nothing. **Sets the vocabulary C44 reuses.**
**Resolves:** Version 5 feature request 3, Calendar half

### Problem

The Calendar is month-only. Its header carries previous / Today / next month
(`client/src/components/CalendarView.tsx:226-245`) and no way to narrow to a day or a week.

### Scope

- A Today / Week / Month switch in the page header, **in the URL beside `month`**, so a view survives
  a reload and can be linked.
- No server work is required for the ranges: `GET /api/calendar` already takes arbitrary `from` and
  `to` (`CalendarView.tsx:200`). The date arithmetic is client-side and belongs in
  `shared/calendar.ts` beside the existing helpers, with tests under a fixed clock.

### The design question to answer on the issue

The Calendar is deliberately an **agenda** — days listed, empty days dropped, because "a month grid
cell cannot hold a post that runs to a thousand characters" (`CalendarView.tsx:41-46`). Decide what
Today and Week mean in an agenda: a one-day agenda is a very short page, and an empty one needs to
say *nothing scheduled today* rather than render blank. Note that C38 removes the original objection
to grids, so if a grid is wanted here that is a separate, later card — not a silent change of shape
inside this one.

### Out of scope — do not build here

- Turning the Calendar into a grid.
- Any write path. The Calendar reads and never writes (`AGENTS.md` §Conventions).
- Signal's planner. That is C44.

### Acceptance criteria

- [ ] All three views render, and the switch reflects the active one.
- [ ] The view and its range survive a reload and reproduce from a pasted URL.
- [ ] Today lands on the local date, not a UTC instant — the existing `today()` rule holds in every
      view.
- [ ] Week boundaries are stated and tested, including across a month boundary and a year boundary.
- [ ] Each view has its own empty state, and none renders blank.
- [ ] Signal being unreadable still degrades to task deadlines with a visible reason, in every view.
- [ ] `client/src/Calendar.test.tsx` and `shared/calendar` tests cover all three under a fixed clock.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: each view across a month
boundary.

---

## C44 — The Signal planner takes the same three views

**Type / branch:** `feat/146-signal-view-switching`
**Size:** L · **Labels:** `enhancement` `size-l`
**Depends on:** **C38** (cells must be bounded first) and **C43** (vocabulary and URL shape)
**Resolves:** Version 5 feature request 3, Signal half

### Problem

The planner is a month grid with no Today control at all — only previous and next month
(`client/src/components/SignalView.tsx:474-493`).

### Scope

- The same Today / Week / Month switch, the same URL parameter name, and the same wording as C43.
  Two pages disagreeing about what "Week" means would be worse than neither having it.
- A **Today** control, which this page lacks entirely.
- `GET /api/signal/posts` already takes `from` and `to` (`SignalView.tsx:360`), so again no server
  work for the ranges.

### The design question to answer on the issue

Does Week keep the seven-column grid, or become a list? The grid is defensible once C38 bounds the
cells; a list holds more text. Decide before building, and follow whatever C43 settled for Today.

### Out of scope — do not build here

- Truncation and expansion, which is C38 and must already be merged.
- The unscheduled queue, which belongs to no cell and no view.

### Acceptance criteria

- [ ] All three views render, with the same labels and URL parameter as the Calendar.
- [ ] Today returns to the current local month/week/day from any position.
- [ ] Editing a post works identically in every view.
- [ ] The unscheduled queue is unaffected by the view.
- [ ] A post stays on its own date in every view — the `date`/`time` pair is never turned into an
      instant (`AGENTS.md` §Conventions), and a test under a non-UTC zone proves it.
- [ ] The >500-post truncation notice still appears where relevant.
- [ ] `client/src/Signal.test.tsx` covers all three views.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Manual: `/signal` in each view, with
`TZ` set west of UTC.

---

# Wave 4 — Publishing

Four cards. **C45 is independent of the other three and should be filed and merged immediately** — it
is a live content defect. C46 unblocks C48; C47 is the prerequisite the decision record already
names.

Source for this wave: `docs/social-media-publisher-artifact.md`, extracted 2026-08-13 from the two
Social Media Publisher artifacts, and `docs/publishing-integration.md` (decision, 2026-08-12).

---

## C45 — Signal's link matcher catches bare domains

**Type / branch:** `fix/147-signal-link-matcher-bare-domains`
**Size:** S · **Labels:** `bug` `size-s`
**Depends on:** nothing. **Independent of everything else in this wave.**
**Resolves:** the defect recorded in `docs/social-media-publisher-artifact.md` §7

### Problem

X removes links from a tweet's body — **full URLs and bare domains alike**. Both Social Media
Publisher artifacts record, in their own words, that Signal's original matcher caught only
`http(s)://` and `www.` forms, so `gholmesdesigns.com` "slipped through and was silently deleted from
the tweet."

This workspace's posts routinely carry UTM-tagged links home. The failure is silent and lands in
published content, which is why it is filed as a bug rather than as part of the publishing work.

### Scope

- Port the TLD-anchored matcher recorded in `docs/social-media-publisher-artifact.md` §7 into shared
  code, and warn wherever Signal shows a post bound for `x`.
- It must catch `gholmesdesigns.com` and `foo.io/path` while ignoring `e.g.` and `3.5 percent`.

### Out of scope — do not build here

- Publishing anything, and any provider call. This card only warns.
- Rewriting post text automatically. Silent edits are the thing being fixed, not the fix.

### Acceptance criteria

- [ ] Bare domains, `www.` forms, and full URLs are all detected in text bound for `x`.
- [ ] `e.g.`, `i.e.`, `3.5 percent`, and decimal numbers are not detected.
- [ ] A warning is visible in the planner where a post targets `x` and carries a link.
- [ ] Nothing is rewritten or removed without the user acting.
- [ ] Table-driven tests cover every case above.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

## C46 — Reconcile the publishing record with the shipped artifact

**Type / branch:** `docs/148-publishing-record-reconciliation`
**Size:** M · **Labels:** `docs` `size-m`
**Depends on:** nothing. **Blocks C48.**
**Resolves:** the seven contradictions in `docs/social-media-publisher-artifact.md` §12

### Problem

`docs/publishing-integration.md` was decided on 2026-08-12 from vendor documentation and is the
document an implementation card is written against. A working integration has existed since
2026-08-02 and disagrees with it on seven points. Building against the record as it stands means
building against a document that is unaware of the thing it is competing with.

### Scope

Amend `docs/publishing-integration.md` to answer each of the seven, keeping or changing the decision
explicitly in every case:

1. **Transport** — the record specifies `POST_BRIDGE_API_KEY` against `api.post-bridge.com/v1`; the
   artifact uses the claude.ai MCP connector and holds no key. The record's choice still looks right
   for a local Express server, which is not subject to the artifact's connectors-only restriction —
   but it must say so rather than appear unaware.
2. **Reach** — the record's four-channel ceiling is a consequence of not modelling media. C47
   removes it. Update §3.
3. **`use_queue`** — ruled out in §5.4; shipped as one of four modes in the artifact. The reasoning
   holds; note that the capability is real and in use.
4. **Buffer** — the record chose Post Bridge *over* Buffer. **Both are in use**, split by channel
   with no overlap, via a local Buffer Bridge. The record's own "revisit when Signal grows a channel
   Post Bridge does not reach" trigger has already fired, for `tt` and `bsky`.
5. **Timezone** — the record requires an explicit `PUBLISH_TIMEZONE` and refuses the DST gap; the
   artifact uses the browser's zone with no DST handling. The record is stricter and better; say so,
   because this is the clearest argument for re-implementing rather than porting.
6. **Caption is mandatory** on every Post Bridge post, even media-only ones. Not currently mentioned.
7. **Provider drafts are a dead end** — sending an existing draft is broken upstream and returns a
   server error. Any design treating a provider draft as a staging step is designing against a route
   that does not work.

Also record the **business rule** from §9: three Facebook pages exist, and only `G.Holmes Designs`
may receive campaign work.

### Out of scope — do not build here

- Any code. This card changes one document and its acceptance checklist.
- Rotating the Buffer key. That is the account owner's to do, by hand, per
  `docs/social-media-publisher-artifact.md` §10.1.

### Acceptance criteria

- [ ] All seven contradictions answered in the record, each with the decision kept or changed
      explicitly.
- [ ] The Facebook page rule recorded.
- [ ] §15's unchecked acceptance box — "Signed off before any implementation card is opened" — is
      either ticked or the reason it cannot be is stated.
- [ ] `docs/social-media-publisher-artifact.md` cross-referenced from the record.

### Verification

`npm run format:check`. No code changes.

---

## C47 — Media on `SignalPost`

**Type / branch:** `feat/149-signal-post-media`
**Size:** XL · **Labels:** `tier-3-schema` `size-xl`
**Depends on:** C46 (so §3 is settled first). **Blocks C48 for six of nine channels.**
**Resolves:** the prerequisite named in `docs/publishing-integration.md` §3 and §14

### Problem

`SignalPost` has no media field, so `ig`, `tt`, and `yt` cannot be published at all and the first
release ceiling is four text-only channels. The artifact shows the shape that removes the limit:
`media_urls`, an array of **public URLs**, with no upload and no file storage — which is exactly what
this app's "stores no user files" rule permits.

### Scope

- Media on `SignalPost` as an ordered list of public `https:` URLs. A normalized join, like channels,
  tags, and categories — never a packed column (`AGENTS.md` §Conventions).
- Kind inferred from the extension, per `docs/social-media-publisher-artifact.md` §4.1, including the
  `unknown` case and why it matters: an extensionless video URL reads as `unknown` and gets a
  platform flagged as missing media it actually has.
- Editing media in the Signal editor.
- Additive migration; existing posts gain an empty list.

### Out of scope — do not build here

- Uploading. Media is referenced, never stored — this app holds no user files.
- Any provider call, preview, or submit. That is C48.
- Per-platform validation of counts and kinds, which belongs in C48's `plan.ts`.

### Acceptance criteria

- [ ] Media persists, reorders, and round-trips through the API with Zod validation at the boundary.
- [ ] Only `https:` URLs are accepted.
- [ ] The migration is additive and idempotent, verified against a populated copy of a real database.
- [ ] Kind inference is table-tested, including `unknown`.
- [ ] The planner shows a post's media count without breaking C38's cell containment.
- [ ] Nothing is fetched, downloaded, or proxied by this app.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run db:migrate` against a copy
of a real `command-center.db`.

---

## C48 — `PublishProvider`, preview, and confirmed submit

**Type / branch:** `feat/150-publish-provider`
**Size:** XXL · **Labels:** `tier-3-schema` `size-xxl` `blocked`
**Depends on:** **C46** and **C47**. Do not start before both have merged.
**Resolves:** the implementation half of FR7, against the record as amended by C46

### Problem

Nothing in this app publishes. `docs/publishing-integration.md` specifies the implementation in
detail — `server/publish/` split into `provider.ts`, `post-bridge.ts`, `mock-provider.ts`, `plan.ts`,
`service.ts`; two new tables; preview-then-confirm; `UNCONFIRMED` never retried. This card builds
that, and no more.

### Scope

Build to the record as C46 leaves it. Three assets from
`docs/social-media-publisher-artifact.md` are carried in directly, because they are proven against
the live API rather than inferred from documentation:

- **The platform capability table** (§3) becomes data in `plan.ts` — caption limits, media
  minimums and maximums, `videoOnly`, `videoAloneOnly`, `noVideo`, `stripsLinks`. This is exactly
  the "database-free rules" that module is specified to hold.
- **The preflight rules** (§6) become its refusal reasons, including the split where an over-length
  caption **blocks on `twitter` and `bluesky` and warns elsewhere**. The wording is already written
  as the fix rather than the fault; keep it.
- **The error taxonomy** (§2) and the ambiguity list (§8) map onto provider failure states. The
  artifact's rule and the record's §8 agree independently, which is the strongest evidence either is
  right.

### Out of scope — do not build here

- Buffer, and the three channels it covers. The bridge is a separate local tool and stays one.
- Analytics, media upload, multi-workspace keys, and any second provider (record §14).
- Auto-publish of any kind. Nothing leaves without a confirmed preview.
- Porting the artifact's transport, timezone handling, or localStorage model — all three are
  answered better by the record and by this app's architecture.

### Acceptance criteria

- [ ] `SignalProvider` gains no write method, and `server/publish/` never imports
      `server/signal/service.ts`.
- [ ] The publisher writes nothing on `signal_posts` — not the date, time, status, or `updated_at`.
- [ ] `PUBLISHED` is never set by the publisher; the planner offers Mark published as the user's own
      write.
- [ ] The instant is computed once, at the outbound edge, in the configured zone, and stored nowhere
      on the post. The spring-forward gap is refused; the fall-back repeat takes the first
      occurrence. Both are tested.
- [ ] Preview and commit are planned by the same function, and a post edited between them refuses the
      commit.
- [ ] An ambiguous submit becomes `UNCONFIRMED` and is never retried automatically.
- [ ] The partial unique index makes a double-submit a constraint violation rather than a race.
- [ ] Every automated test runs against `mock-provider.ts`. **No test reaches the real API.**
- [ ] No credential reaches SQLite, the browser, a log line, or `integration_events`.
- [ ] `docs/publishing-integration.md` and `USER_MANUAL.md` are updated in this branch.

### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:coverage`,
`npm run test:e2e`. Manual verification against the real provider is the account owner's, from a
scheduled post placed a short way out — never from Publish now, per the artifact manual's own
recommended test procedure.

---

## Filing checklist

- [x] Four milestones created: `Wave 1 — Paper cuts` (#14), `Wave 2 — Status visibility` (#15),
      `Wave 3 — Ordering and views` (#16), `Wave 4 — Publishing` (#17).
- [x] C31–C48 filed as #133–#150, each with the labels in the index table and its milestone set.
- [x] All eighteen added to the **Command Center v5** board.
- [ ] **Answer the three blocking questions before their cards start:** C40/#142's privacy reversal,
      C42/#144's ordering model, C39/#141's CSS-class scope.
- [ ] Every merged card bumps the version and adds a `CHANGELOG.md` entry in its own branch, gated by
      `npm run check:version-bump`.

Suggested start: **C45/#147** — it is `size-s`, depends on nothing, and fixes content that is
publishing wrong today.

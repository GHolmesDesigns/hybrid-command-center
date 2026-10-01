# Version 6.10.5 Implementation Brief

## Purpose

Turn the Version 6.10.5 backlog notes (five items with operator screenshots, last edited
25 September 2026) into work that is ready to implement. For each item, this brief records what
was asked for, what the code does now, the proposed behaviour, and the code to change. This is a
planning document, not an instruction to make any of these changes immediately.

The first review used a stale version label: the local checkout is `ebb401a` with app version
6.10.20, while `origin/main` is currently 6.10.24. The line references below are therefore
orientation only. Before implementation, refresh every seam, reproduction, and test expectation
against the exact branch head being changed.

## Recommended delivery shape

| # | Item | Kind | Size | Order |
| --- | --- | --- | --- | --- |
| 1 | A project with Signal posts cannot be deleted | **P1 bug** | S | First |
| 2 | Project details on the Status page | P2 UI | S | Independent |
| 3 | Resizable Signal calendar rows | P2 UI | S–M | Independent |
| 4 | New Add post and Command AI icons | P2 UI | S | Independent |
| 5 | Dark mode in Settings | P2 feature | XL (two cards) | Last. Token pass before the toggle |

Item 1 is the only defect, and a reproduction confirms it. The other items are independent
of each other, except that dark mode is easier to add after item 4, when the icon glyphs are no
longer hard-coded fills.

---

## 1 A project with Signal posts cannot be deleted (P1 bug)

### Report

> Deleted project still shows on the Client Page and cannot be deleted

Screenshot: project *DELETE THIS - Six Weeks of Clarity — Week 1: The Problem* (status ARCHIVED),
**Delete project** pressed, toast *"Something went wrong on the server."* The project description
says it was "created to hold the Aug 24–28 cascade during the C201 Signal assignment backfill", so
Signal posts are assigned to it.

### Root cause (confirmed)

`signal_posts.project_id` is a foreign key to `projects(id)` with no `ON DELETE` action
(`server/db.ts:305`), and `PRAGMA foreign_keys = ON` (`server/db.ts:14`). `deleteProject`
(`server/workspace/writes.ts:223-241`) deletes tasks, `drive_steps`, and the project row, but it
does not handle Signal posts. If any post still points at the project, SQLite rejects the
`DELETE FROM projects` with `FOREIGN KEY constraint failed` and the transaction rolls back. The
error is not a workspace error class, so the API returns a generic 500
(`SERVER_ERROR_MESSAGE`, `server/app.ts:429`).

Reproduction against an in-memory database built by `createDb(':memory:')`:

```text
p-plain  -> deleted
p-signal -> THROWS ERR_SQLITE_ERROR FOREIGN KEY constraint failed
remaining projects [ 'p-signal' ]
```

The project was never deleted, so it still appears on the Client page. The two symptoms in the
report have one cause. The MCP tool `workspace_delete_project`
(`server/mcp/workspace-write.ts:579`) calls the same function and fails the same way.

No existing test covers this. `server/workspace/writes.test.ts:206` and `server/app.test.ts:904`
delete only projects that have no Signal posts.

`signal_posts` is the only foreign key that can block the delete. `checklist_items`,
`task_dependencies`, `task_tags`, and `project_categories` all cascade. The soft references
(`agent_conversations.scope_id`, `agent_memory.scope_id`, `agent_handoffs.subject_id`,
`agent_work_sessions.subject_id`, `agent_schedules.subject_id`) are not foreign keys, so they
do not block anything. They are out of scope here, and they already behave this way when a task
is deleted.

### Proposed behaviour

**Detach, don't delete.** Inside the same transaction, `deleteProject` first selects the assigned
post IDs and current revisions, then updates each post's `project_id` to `NULL` and its
`updated_at`. It must call `advanceRevision` exactly once for each changed post, with the same
revision-change record used by `signal_assign_posts`; it must not also increment `revision` in the
SQL update. The posts stay on the Signal schedule with no project assigned. This follows the rule
that deleting a label detaches it and never deletes what it was attached to, and the rule that
Signal is authoritative for what is scheduled. A post and its publication history must never be
removed as a side effect of deleting a project.

The operation should count assigned posts before deletion and return that count. The count is
needed before confirmation in the browser, so expose it through the project read model or a
dedicated read endpoint rather than trying to learn it from the eventual DELETE response.

### Acceptance criteria

- [ ] Deleting a project with assigned Signal posts succeeds. The posts remain, `project_id` is
      `NULL`, and date, time, text, campaigns, channels, publications, and targets are unchanged.
- [ ] Detached posts have their `updated_at` and revision advanced exactly once, with an
      `entity_revision_changes` row recording the project assignment change.
- [ ] Deleting a project with no Signal posts behaves exactly as it does now.
- [ ] The confirmation text and field hint in both project-delete entry points
      (`ProjectDetail.tsx` and `Projects.tsx`) say how many Signal posts will be unassigned (not
      deleted) when there are any.
- [ ] The response reports the number of detached posts, and the browser and MCP callers surface
      that result accurately.
- [ ] The deleted project disappears from the Client page and the Projects list without a reload.
- [ ] Regression test: a project with one assigned Signal post. The focused assertion fails on
      the refreshed baseline head with the foreign-key error and passes with the fix. Assert the post row afterwards,
      including unchanged content/delivery fields, the new revision, and the revision-change row;
      do not assert only the status code.
- [ ] MCP coverage (`workspace_delete_project`) asserts the detached-post count, unchanged post
      data, and successful idempotent completion.

### Code seams

- `server/workspace/writes.ts:223-241`: `deleteProject`.
- `server/workspace/writes.test.ts:180-213`, `server/app.test.ts:904-920`: extend these.
- `server/mcp/workspace-write.ts:579`, `server/mcp/registry.ts:867-889`: MCP caller and tool
  description/schema contract.
- `client/src/components/ProjectDetail.tsx:128-143, 221-226`,
  `client/src/components/Projects.tsx:248-261`: confirmation, hint, and result copy.
- The project read model or a small project-post-count endpoint: pre-delete confirmation needs a
  count before the DELETE request.
- `server/db.ts:305`: leave the foreign key as it is. Changing it to `ON DELETE SET NULL` requires
  a table rebuild, and `db.ts` is additive by design.

### Production cleanup

After the fix ships, **Delete project** on the stuck project should work without a data repair:
the project row is still present and the existing Signal assignment is the data to preserve. That
claim still needs an authorized owner-run production check; the production MCP connector returned
401 during this study, so the post count on that project was not read.

---

## 2 Project details on the Status page (P2 UI)

### Request

> Add project details to the Status page

The screenshot marks the empty band under the *Project Status* subtitle, with the board filtered to
one project (`/status?project=…`). A second screenshot shows the Edit project form: client,
description, status, priority, start date, planned launch date, target deadline, categories, and
notes.

### Current state

`client/src/components/Kanban.tsx:329-345` renders `PageHead` with the task count only. Project
fields are not shown on this page.

### Proposed behaviour

When the Project filter selects **exactly one** project, show a compact project summary between the
page head and the filter bar:

- Description (the one the project page shows as its subtitle).
- The same tiles as the project page (status, planned launch, target deadline, priority, task
  health), plus start date. The shared component must also update the project page so status uses
  the repository's label-and-icon presentation rather than raw text or colour alone.
- Category chips.
- Links to **Open project** and **Edit project**. Edit opens the existing modal.

For zero projects or more than one, show nothing. Notes are long free text and are omitted by
default. See decision D2.

Extract the `.project-summary` markup from `ProjectDetail.tsx:175-206` into a shared
`ProjectSummary` component rather than copying it, so the two pages cannot drift apart. The
component should own the description fallback, date formatting, status presentation, task-health
calculation, category chips, and the Open/Edit actions required by each host page.

### Acceptance criteria

- [ ] Shown only when exactly one project is selected. Selecting a second project hides it, and
      clearing the filter hides it.
- [ ] Values match the project page for the same project, including "Not set".
- [ ] Status is paired with its label and icon (project-status palette) on both Status and the
      project page, never shown by colour alone.
- [ ] Editing the project from the Status page updates the summary without a reload.
- [ ] Responsive: tiles wrap at the existing breakpoints, with no horizontal scroll at 375 px.

### Code seams

- `client/src/components/Kanban.tsx:329-346`.
- `client/src/components/ProjectDetail.tsx:175-206`: extract from here.
- `client/src/components/project-status.ts`: palette and labels.
- `client/src/Kanban.task-type.test.tsx:39` parses the task count out of `.page-head`. Keep the
  summary outside `.page-head`, or update that helper.

---

## 3 Resizable Signal calendar rows (P2 UI)

### Request

> Make box expandable, add drag region to lower right corner

The screenshot shows the Signal **Today** view on 1 September. The day cell has a scrollbar, and a
red arrow points to the lower-right corner of the calendar panel.

### Current state

Every calendar row has a fixed height, `.signal-grid { grid-auto-rows: 184px; }`
(`client/src/styles.css:4340-4342`), and posts scroll inside the cell (`.signal-day ul`,
`:4369-4375`). This was intentional, so the longest post in a week cannot stretch the whole week.
In the Today view, which has one cell, the result is a 184 px window onto a full day.

### Proposed behaviour

Keep fixed rows, but make the row height adjustable:

- Row height comes from a CSS custom property, `--signal-row-height`, with a default of 184 px.
- A dedicated grid wrapper inside `.signal-calendar` owns the row height and resize grip; the
  calendar navigation and view switcher do not become part of the resizable area.
- A resize grip in the lower-right corner of that grid wrapper changes the height by dragging. It
  is a real control: `role="separator"`, `aria-orientation="horizontal"`, `aria-valuenow`,
  `aria-valuemin`, `aria-valuemax`, focusable, **Arrow Up/Down** in 24 px steps, and **Home** to
  reset. Pointer listeners must clean up on pointer cancel/up, including when the pointer leaves
  the grid. Native CSS `resize` is not keyboard-operable, so it does not meet the focus rule.
- Clamp between 184 px and a view-aware maximum. See decision D3.
- The height is a per-device preference kept in `localStorage`, like the sidebar-collapsed state
  (`App.tsx:269`). It is not URL state (`docs/view-state-convention.md`) and not a server setting.
- The height is stored per view (Today, Week, Month), because a comfortable Today height is far too
  tall for a six-row Month. See decision D3.

### Acceptance criteria

- [ ] Dragging the grip changes the row height, and posts in the cell scroll less or not at all.
- [ ] The keyboard alone can grow, shrink, and reset the height, with a visible focus ring.
- [ ] Every row in a view stays the same height. Content never stretches a single row.
- [ ] The height survives a reload on the same device and does not change other devices.
- [ ] If `localStorage` is unavailable (throws), the page falls back to 184 px without breaking.
- [ ] No effect on the unscheduled queue panel.
- [ ] Month view cannot accidentally create a multi-thousand-pixel calendar by using the Today
      maximum for every row.

### Code seams

- `client/src/components/SignalView.tsx:2558-2640`: calendar section and grid.
- `client/src/styles.css:4306-4380`, and the mobile block at `:5145-5170`.

---

## 4 New Add post and Command AI icons (P2 UI)

### Request

> Update icons accordingly

Two mock-ups:

- **Add post**: a document with two text lines and a plus at the lower right.
- **Command AI**: a speech bubble with a four-point sparkle and three short rays. It is shown as a
  square tile, inside the dark topbar button next to the label, and as the round floating button.

### Current state

- The topbar **Add post** button uses lucide `Plus` (`client/src/components/App.tsx:120`).
- The topbar **Command AI** button uses lucide `MessageSquare`
  (`client/src/components/CommandAiPanel.tsx:987`).
- The floating button uses lucide `Sparkles` (`CommandAiPanel.tsx:97`).

The Command AI button and the floating button therefore show different glyphs for the same thing.
The mock-ups use one glyph for both.

### Proposed behaviour

- Add post: lucide `FilePlus2` is a close match to the mock-up (document, lines, corner plus) and
  keeps the icon set consistent. Alternatively, draw a custom glyph. See decision D4.
- Command AI: lucide has no icon with a bubble, sparkle, and rays. `BotMessageSquare` and
  `MessageSquareDot` are the closest. Recommended: one small inline-SVG component,
  `CommandAiGlyph`, drawn on lucide's 24 px grid with a 2 px round stroke and `currentColor`, so it
  sizes and themes the same way as every other icon. Use it in the topbar button, the floating
  button, and the panel header.
- Also replace the `Plus` in Signal's own **Add post** button (unscheduled queue) so the two entry
  points to the same form match.

### Acceptance criteria

- [ ] The same Command AI glyph appears in the topbar button, the floating button, and the panel
      header.
- [ ] Both glyphs use `currentColor` (no hard-coded fill), so they work in dark mode later.
- [ ] Accessible names are unchanged (`Open Command AI`, `Add post`).
- [ ] Checked at 16, 20, and 24 px for legibility.

---

## 5 Dark mode in Settings (P2 feature)

### Request

> Dark mode in settings

### Current state

There is no theme support. `client/src/styles.css` is 7,075 lines with **314 hard-coded hex
colours** (`#fff` alone appears 41 times), in addition to the 12 tokens on `:root`. There is no
`prefers-color-scheme` or `data-theme` rule anywhere. Colours also live in TypeScript: the
project-status palette in `project-status.ts`, tag and category colours, and the branding sidebar
palette, whose contrast rules in `shared/contrast.ts` are enforced by both the API and the form.

### Proposed shape: two cards

**5a: colour-token pass (chore, no visual change).** First inventory the semantic roles, then
replace presentation colours in `styles.css` with tokens (`--surface`, `--surface-sunken`, `--ink`,
`--muted`, `--line`, `--accent-*`, the status inks and washes, and so on). Do not blindly replace
data colours, the user-configured sidebar palette, or provider/status colours that need their own
contrast treatment. The acceptance test is that the light theme is visually identical: use a
fixed route/viewport screenshot matrix before and after, plus computed-style checks for the token
inventory. This is the bulk of the work, and it is safe to land on its own.

**5b: dark theme and toggle.** Add a **Theme** section to Settings with **System** (default),
**Light**, and **Dark**:

- `data-theme` goes on `<html>`. **System** follows `prefers-color-scheme` and tracks changes live.
- The preference is per device in `localStorage`, like other viewing preferences. See decision D5.
- Set the theme before first paint so a dark-mode user does not get a white flash. Because the
  production CSP forbids inline scripts, use a same-origin bootstrap script or add and test the
  exact static script hash in the production CSP; do not add `unsafe-inline`.
- Dark values for every token, measured with `shared/contrast.ts` against the same AA rules the
  suite already enforces. That includes the project-status palette, which Wave 40 measured only
  against light surfaces.
- The sidebar keeps its branding palette in both themes, since it is already dark and configurable.
- Tag and category colours chosen by the user are checked against the dark surface as well. Where
  one fails, the chip uses an outlined treatment instead of recolouring the tag. This requires
  extending the existing contrast rule and its tests, not just adding CSS overrides.
- Update native control rendering with `color-scheme`, update the browser `theme-color` where
  appropriate, and fall back to System when `localStorage` is unavailable.

### Acceptance criteria (5b)

- [ ] Settings → Theme shows System, Light, and Dark. The choice applies immediately and survives
      a reload on that device.
- [ ] No light flash on load in dark mode.
- [ ] Every text and surface pair meets AA in both themes. The existing contrast tests run for
      both.
- [ ] Status colours stay paired with text and icons, and focus rings stay visible in both themes.
- [ ] One `e2e/` spec covers toggling the theme and reloading; unit coverage includes system
      preference changes, invalid/unavailable storage, and the pre-paint bootstrap contract.

### Code seams

- `client/src/components/SettingsView.tsx`: Theme settings and immediate preference changes.
- `client/src/styles.css`: semantic light/dark tokens, native control rendering, and focus states.
- `client/index.html` plus the production CSP in `server/app.ts`: pre-paint bootstrap delivery
  without weakening the inline-script policy.
- `shared/contrast.ts`, `client/src/components/project-status.ts`, and tag/category chip styles:
  shared contrast rules for both themes.

---

## Decisions for the owner

Each decision has a recommendation. None of them blocks item 1.

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Item 1: detach Signal posts (set to no project) or refuse to delete while posts are assigned? | **Detach.** Posts and their publication history are Signal's. Refusing would make every project that was ever assigned a post permanently undeletable. |
| D2 | Item 2: which fields appear on Status? | Description, status, start, launch, deadline, priority, task health, categories, and links to open or edit the project. **Omit notes.** |
| D3 | Item 3: one height for all views, or one per view? What is the maximum? | **Per view.** Today and Week use a maximum of 640 px or 70 % of the viewport, whichever is smaller; Month uses a lower maximum of 320 px or 70 % of the viewport, whichever is smaller. All maxima remain at least the 184 px minimum. |
| D4 | Item 4: lucide `FilePlus2` for Add post, or a custom glyph? | **`FilePlus2`**, plus one custom `CommandAiGlyph`, since lucide has no match for that one. |
| D5 | Item 5: theme per device or per workspace? | **Per device**, defaulting to System. A workspace setting would force dark mode on every screen that signs in. |
| D6 | Item 5: ship the token pass (5a) as its own card before the toggle (5b)? | **Yes.** 5a is large but carries no visual change, which makes it easy to review. 5b is then mostly new values. |

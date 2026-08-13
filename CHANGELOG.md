# Changelog

All notable changes to Hybrid Command Center are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 3.0.0 were not recorded in this file; `git log` is authoritative for them.
The version a card ships as is decided at merge time — see the bump rule in `AGENTS.md`.

## [4.1.9] - 2026-08-13

### Changed

- The Status board now lives at `/status`. The nav item, breadcrumb, dashboard tiles, and every
  in-app link that opened the board point there. `/kanban` still works: it redirects to `/status`
  and keeps whatever query string it had, so an old bookmark filtered to today still opens today's
  board.

### Fixed

- Calendar links to a task's board no longer append a `task` query parameter the board never
  read. They keep the project filter only. Opening a specific task from the calendar is left for
  a later card rather than half-wired through a dead parameter.

### Notes

- CSS class names (`.kanban-board`, `.kanban-column`, `.kanban-card`) stay as they are. Renaming
  them would double the diff and churn e2e selectors without changing anything a user sees.

### Breaking changes

None. `/kanban` remains as a redirect.

## [4.1.8] - 2026-08-13

### Fixed

- The version-bump gate's own test no longer times out under a full suite run. Each case now
  has a file-scoped budget that matches starting a real Git repository and a real Node child,
  and the shared initial commit is copied per case instead of rebuilt ten times. The suite-wide
  default timeout is unchanged.

### Breaking changes

None.

## [4.1.7] - 2026-08-13

### Fixed

- A Signal day cell no longer grows to fit the longest post in it. Every cell in the month is
  one height, so a thousand-character campaign post can no longer stretch its day and the whole
  of that week's row with it. A cell holding more than fits scrolls on its own.

### Added

- A post longer than its cell shows its opening, ending in an ellipsis, with **Show more**
  underneath. **Show more** opens the rest of that post where it sits and moves nothing else on
  the page; **Show less** puts the opening back. It is a separate control from the post itself,
  reachable and labelled on its own, so revealing the text and opening the editor can no longer
  be mistaken for each other. Queue items are still shown whole — the queue is a column of its
  own with no day beside it to stretch.

### Breaking changes

None.

## [4.1.6] - 2026-08-13

### Added

- The client and project named on a task's detail panel are now links to those detail pages.
  Following one closes the task panel and moves focus to the heading of the page it opened, so
  the journey from a task to the work around it no longer means closing the panel and finding
  the record by hand. A name whose record no longer exists stays plain text rather than
  offering a link that would lead nowhere.

### Breaking changes

None.

## [4.1.5] - 2026-08-13

### Added

- The Import page offers the sample playbook. **Download sample playbook**, beside **Import a
  playbook** at the top of the page, saves the filled-in workbook — every tab, in order, with its
  columns already named — so a first import starts from a working file instead of from a column
  list. Until now that workbook shipped with the application but nothing served it, and the page
  could only name the folder it was in.

### Changed

- The Import page's note about the format now points at the download rather than only at the
  format document.

### Breaking changes

None.

## [4.1.4] - 2026-08-13

### Changed

- Task details now presents Checklist, Notes, Tags, and Dependencies in that order, putting
  progress and working text ahead of labels while keeping Dependencies last. The sections'
  content and behaviour are unchanged.

### Breaking changes

None.

## [4.1.3] - 2026-08-13

### Added

- The Status board filters by task type. The new control offers every type, plus **No type** for
  the tasks that carry none — untyped work predates the field and is normal, so it is findable
  rather than merely not excluded. The type narrows the board alongside the client, project,
  priority, focus, tag, and search filters rather than replacing any of them.

### Changed

- The task type and priority selections are now carried in the page address, as the client,
  project, focus, and tag selections already were. Priority was the last filter that reset on a
  reload; a filtered board now reloads and shares as a link exactly as it was left. The filter
  bar also wraps onto a second line at narrow widths instead of running off the side of its card.

### Breaking changes

None.

## [4.1.2] - 2026-08-13

### Added

- Tasks can now be classified as Dev Work from the task form. The type appears on task cards
  and task details, is accepted by campaign playbook imports, and does not add a default
  checklist because development workflows vary by task. Existing typed and untyped tasks are
  unchanged.

### Breaking changes

None.

## [4.1.1] - 2026-08-13

### Fixed

- The Google Drive card on Settings no longer runs on into several hundred pixels of blank
  white space. It was being stretched to the height of the two cards beside it, so it stood
  more than a thousand pixels taller than the content it held; it now ends where its content
  ends, in every Drive state — credentials missing, disconnected, connected without a root
  folder, and connected with one set. Every other Settings card sizes to its content in the
  same way, which also closes the shorter gap that sat under Local timezone. Settings is
  around 400px shorter to scroll at desktop width, and the single-column layout below 1100px
  is unchanged.

### Breaking changes

None.

## [4.1.0] - 2026-08-13

### Fixed

- The Description and Notes labels on Task details no longer sit flush against the box you
  type into. Both inline editors now leave 10px between the label and its textarea, so the
  field reads as a labelled field rather than as one block of text. Every other form in the
  app — Settings, Task, Project, Client, and the Signal editor — is unchanged.

### Breaking changes

None.

## [4.0.0] - 2026-08-13

A version-only major bump. The application code, HTTP API, database schema, and
configuration are byte-for-byte unchanged from 3.1.3.

### Changed

- `package.json`, both `package-lock.json` version fields, and `APP_VERSION` in
  `shared/branding.ts` moved to `4.0.0`. `server/version-consistency.test.ts` holds all
  four to the same value, and `npm run check:version-bump` gates the result in CI.
- The version the sidebar foot, the Settings pane, and `GET /api/branding` report now reads
  `v4.0.0`.

### Added

- This changelog.

### Breaking changes

None. Nothing was removed, renamed, or given different behaviour, so no upgrade step
applies: the major digit was raised on request rather than to signal an incompatibility.
Semantic Versioning reserves the major position for incompatible API changes, so a future
reader should not infer one from this release.

## [3.1.3] - 2026-08-12

### Fixed

- The server refuses a non-loopback bind while nothing authenticates, rather than exposing
  an unauthenticated instance by a `HOST` change alone.

## [3.1.2]

### Changed

- The import and Drive routes carry request budgets.

## [3.1.1]

### Added

- CI measures coverage and holds each project to its own floor.
- Drive scope exposure and revocation are documented.

## [3.1.0]

### Added

- A private single-instance cloud shape is recommended for Infra 2, in `docs/cloud-hosting.md`.

## [3.0.3]

### Added

- Backups carry a retention count, and the restore rehearsal carries a schedule.

## [3.0.2]

### Added

- Supply-chain gates in CI.

## [3.0.1]

### Fixed

- The branding reset waits to reach the form before it resolves.

## [3.0.0]

### Added

- The Signal planner: `signal_posts` is the only store of planned content, read through
  `SignalProvider`, which has no write method by construction.

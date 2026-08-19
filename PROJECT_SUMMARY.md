# PROJECT_SUMMARY

Serialized work reports from the agents that built this lineage. Codex covers Master Project Command Center. Claude covers Drive Command Center. Cursor covers Hybrid Command Center after the 10 August 2026 hybrid initial commit.

## Cursor - Cyber24

Hybrid Command Center is a local-first studio command center. Clients, projects, and tasks live in SQLite. Google Drive holds project files and is provisioned from the app. Folder names never create or own projects.

It started from Master Project Command Center (Codex) infrastructure — SQLite, Express API, Drive provider, Kanban, deadlines, OAuth — and took Hybrid V2 sidebar, branding, sync, and delete/rename controls from Drive Command Center (Claude). The decision that stuck: SQLite owns operational records; Drive owns files.

### Snapshot

As of 16 August 2026, 21:33 EDT.

| | |
| --- | --- |
| Repository | `GHolmesDesigns/hybrid-command-center` |
| Branch | `main` matches `origin/main` |
| Version | **4.3.0** (`package.json` and `APP_VERSION`) |
| First commit | 10 August 2026 (`8804b00`, v2.0.0) |
| Commits | 199 |
| Merged pull requests | 87 |
| Closed issues | 86 |
| Open issues | 0 |
| Open pull requests | 0 |
| Authors | Garnie Holmes (105), GHolmesDesigns (96), dependabot (1) |

Commit volume by day:

| Date | Commits |
| --- | ---: |
| 10 Aug | 13 |
| 11 Aug | 69 |
| 12 Aug | 50 |
| 13 Aug | 47 |
| 14 Aug | 4 |
| 15 Aug | 9 |
| 16 Aug | 7 |

The first four days built the product and the quality gates. The last three days are smaller, card-sized ships on that base. All 18 GitHub milestones have zero open cards.

### Work completed

- **Clients, projects, and tasks** in SQLite, with archival for clients, record-only delete for projects and tasks, and Drive left untouched by those actions.
- **Merge one client into another** (4.3.0): a previewed, confirmed, single-transaction move of every project from a duplicate client to the client being kept. The source is archived as an alias; contact details are not combined; Drive is not touched; there is no undo.
- A **deadline-led dashboard** (overdue, due today, seven-day, project health) and **Sync to Folder**, which provisions missing Drive folder skeletons and never discovers projects from Drive.
- A five-stage **Status board** at `/status` (`/kanban` redirects), with persistent order, drag-and-drop, and filters for client, project, priority, task type, focus, tags, and search, all carried in the page address.
- **Task types** for studio work, including Dev Work; checklists; dependency blocking; tags; inline edit; notes on cards; and links from a task to its client and project.
- **Project categories**, seven sort modes, custom tile order, status chips on tiles, and project-page task grouping that shares one order with the Status board.
- **Campaign playbook import**: preview, one transactional commit, skip-and-report duplicates, a persisted receipt, and a downloadable sample workbook. No Drive side effect.
- **Files**: read-only browsing of a project's Drive folder and its provisioned subfolders.
- **Integration activity**: an append-only, credential-scrubbed log of what each integration changed, bounded to the newest 200 rows.
- **Signal Campaign**: the only store of planned content — Today/Week/Month views, unscheduled queue, editor, ordered public media URL references, X-link warnings, and an optional Post Bridge publish flow with preview and confirmed submit.
- **Signal campaigns**: a shared label list over Signal posts — several per post, one write to rename, deletion detaches without deleting a post — with the platforms' own figures added up per campaign below the planner and filterable by campaign, channel, account, and date range. Unclassified posts stay visible under **No campaign**.
- **Calendar**: a read-only Today/Week/Month agenda that keeps Signal posts and task due dates as two headed groups, and degrades to tasks alone if the schedule cannot be read.
- **Branding** in Settings (wording, colours, optional `https:` logo) with WCAG AA contrast enforced on both the form and the API.
- Server-only Google OAuth, encrypted tokens, PKCE, consumed-state delete, loopback-only bind while there is no authentication, backups with retention, and CI gates for typecheck, lint, tests, coverage floors, e2e, supply chain, and version consistency.
- Operator and developer documentation covering installation, daily use, Drive security and revocation, import formats, publishing architecture, backups, troubleshooting, and a potential future cloud deployment.

### How the work was sequenced

GitHub milestones are still open as labels, but their cards are closed. The sequence they describe is the actual build order.

**Foundation (Phases 0–5 and tooling).** Reformat, bind the API to loopback, validate dates, isolate the e2e database, stand up the migration runner, and put lint, typecheck, tests, and Playwright in CI. Schema work in this band includes tags, categories, and related joins. Tooling baseline added version consistency, production CSP, coverage measurement, backup retention and restore rehearsal, and supply-chain gates.

**Product stages.**

1. Dashboard correctness — overdue / due-today / week counts and board filters that share one set of deadline rules.
2. Task detail and hygiene — checklists, notes, dependencies, rename, delete, completion override, inline edit.
3. Project organization — categories, sort, custom order.
4. Integrations — campaign playbook import, read-only Files, integration activity log, Drive OAuth hardening.
5. Cloud decision — private single-instance shape recorded in `docs/cloud-hosting.md`. The app stays local-first and refuses a non-loopback bind while nothing authenticates.

An interlude in the same window hardened SQLite durability, boot-time config validation, and the HTTP error boundary.

**Signal and calendar (3.0.x).** Version 3.0.0 introduced Signal as the authoritative schedule: `signal_posts` behind a read-only `SignalProvider`, writes in a separate service, and the campaign archive imported idempotently. The calendar composes that schedule with task due dates and never writes. Follow-up patches added the cloud-hosting recommendation, coverage floors, Drive-scope documentation, request budgets, and the loopback bind gate.

**Version 4.** 4.0.0 is a version-only major bump (requested; no behaviour change) and the start of `CHANGELOG.md`. Releases before 3.0.0 are not in that file; `git log` is authoritative for them.

4.1.x is a dense day of paper cuts and Status-board work (13 August): inline-editor label gap, Settings Drive card height, Dev Work type, task-type filter, task-detail section order, sample playbook download, client/project links from a task, Signal day-cell containment, `/kanban` → `/status`, and the changelog-fragment workflow so concurrent cards stop colliding on the version number.

4.2.x is publishing: reconcile the decision record with the shipped Post Bridge artifact, ordered media URL references on Signal posts, then preview-and-confirm publish with timezone conversion, preflight, and per-target delivery records.

4.3.0 is client merge (C49 / #173 / PR #175), merged 16 August 2026.

Waves 2–3 (C40–C45) also landed on `main` after 4.2.2: notes on task cards, project-tile status, project-page task ordering, calendar view switching, Signal view switching, and Signal bare-domain link warnings. Their user-facing text still sits in `changes/*.md` fragments and has not been folded into dated `CHANGELOG.md` headings.

### Quality and operating rules that stuck

- One card per branch, named `<type>/<issue>-<slug>`. Version numbers are assigned at merge time, not when the branch is created.
- Draft PRs carry `changes/<issue>.md` and leave the four shared release files alone. Ready PRs contain the finalized version and no fragment for that card.
- The browser never sees Google tokens. Drive writes are not methods on the read-only browse path. Signal writes are not methods on `SignalProvider`. The calendar reads and never writes.
- Automated tests use a mock Drive provider. Every milestone adds at least one Playwright spec; not every card.
- Coverage thresholds in CI are measured floors, not targets — they are raised when the suite covers more, not lowered to pass a branch.

### Current status

The board is empty. `main` is at **4.3.0**. There is no in-flight card.

Process leftover: changelog fragments for C40–C45 remain under `changes/` after those cards merged, so `CHANGELOG.md`'s latest dated heading is 4.3.0 (client merge) and does not yet list those six ships.

For additional detail, see [README.md](README.md), [CHANGELOG.md](CHANGELOG.md), and [USER_MANUAL.md](USER_MANUAL.md).

## Claude - Cyber24

### Scope of this report

Reported 16 August 2026 against `main` at `89da67b`, after PR #175 merged. Every figure below was read from the working repository, `git`, and the GitHub API at that moment.

One limit belongs at the top of a serialized report. Git carries no agent attribution: all 199 commits are authored under `Garnie Holmes` (105), `GHolmesDesigns` (93), and dependabot (1). Nothing in the history separates one agent's commits from another's. This section is therefore a verified account of the project's state, boundaries, and risks — not a claim of exclusive authorship over any part of it. Where it overlaps the Cursor section, treat the two as independent readings of the same record rather than separate bodies of work.

### Snapshot

| | |
| --- | --- |
| Branch | `main`, matching `origin/main` |
| Head | `89da67b` (merge of PR #175) |
| Version | **4.3.0** |
| Commits | 199 |
| Merged pull requests | 87 |
| Closed issues | 86 |
| Open issues / pull requests | 0 / 0 |
| Tracked source files | 69 server, 66 client, 23 e2e, 19 shared |
| Unfolded changelog fragments | 6 (`changes/142`–`147.md`) |

### Architecture and the boundaries that hold it together

The product is one decision applied repeatedly: **SQLite owns operational records, Drive owns files, and neither is allowed to infer the other.** The boundaries that enforce it are structural, not conventional — each is a place where the wrong method simply does not exist:

- Google tokens are held server-side, encrypted, and never reach the browser. OAuth uses PKCE and deletes consumed state.
- The Drive browse path is read-only by construction; writes are not methods on it.
- `SignalProvider` is read-only; Signal writes live in a separate service.
- The calendar composes the Signal schedule with task due dates and never writes to either.
- `Sync to Folder` provisions missing folders from records. It never discovers a project from a folder.
- Campaign playbook import, client merge, and every other multi-record write commit once or not at all.

While nothing authenticates, the server refuses a non-loopback bind. That gate is the only thing standing in for an auth layer, and it is what makes the app safe to run as-is.

### Quality gates

CI enforces, on every branch: TypeScript (`tsc --noEmit`), ESLint, Prettier check, Vitest unit and integration suites, measured coverage floors, a production build, dependency and supply-chain audit, version consistency (`check:version-bump`), and Playwright end-to-end specs. Automated tests run against a mock Drive provider, so no suite touches a real Google account. Coverage thresholds are floors raised as the suite grows — never lowered to make a branch pass.

Operationally: validated environment configuration at boot, request budgets on import and Drive routes, secret redaction in logs, SQLite WAL with lock waiting, health checks, controlled shutdown, production CSP, and backups with retention plus a scripted restore rehearsal (`npm run db:backup:rehearse`).

### Release process

The convention worth carrying forward is that **a version number is assigned at merge, not at branch creation.** A card branches as `<type>/<issue>-<slug>` and carries its user-facing text in `changes/<issue>.md`, leaving the four shared release files untouched; the version and changelog entry are written only when the card is ready to land. This exists because concurrent cards were colliding on the version number, and it is the reason 4.1.x could ship eleven times in one day without conflicts.

### Current status

The board is empty. `main` is at 4.3.0 with no in-flight card. Client merge (C49 / #173) is merged and released.

### Open items and risks

1. **Six merged cards are not in `CHANGELOG.md`.** Fragments for C40–C45 (#142–#147) remain under `changes/`, so the latest dated heading is 4.3.0 (client merge) and omits notes on task cards, project-tile status, project-page task ordering, calendar views, Signal views, and Signal link warnings. This is the one process leftover in the tree.
2. **There is no authentication layer.** The loopback bind gate substitutes for one. Any move to the private single-instance shape in `docs/cloud-hosting.md` is blocked on building real auth first.
3. **Client merge has no undo.** Recovery is restore-from-backup only. The guards against silently reversing a merge — no unarchive, no re-targeting, no reassigning a project back — are in place, but the operation itself is one-way.
4. **Version 4 and 5 planning material is committed but unscheduled.** `VERSION_4_FEASIBILITY_REPORT.md`, `VERSION_5_CARDS.md`, and `VERSION_5_FEASIBILITY_REPORT.md` sit in the root with no cards behind them.
5. **History before 3.0.0 is not in the changelog.** `git log` is authoritative for that band.

## Codex - Cyber24

### Scope and attribution

Reported 16 August 2026 after rechecking the repository at `main` commit
`89da67b`. This is the serialized Codex collaboration record reconstructed from
prior task records and verified against the current Git history. Git does not
encode which AI agent produced a commit, so the entries below identify work
that prior Codex task records explicitly cover; they do not claim exclusive
authorship over the rest of the product.

### Current verified state

| | |
| --- | --- |
| Branch | `main`, matching `origin/main` |
| Head | `89da67b` (merge of PR #175) |
| Version | **4.3.0** |
| Commits | 199 |
| Merged pull-request commits | 87 |
| Tracked working-tree changes | None |
| Preserved untracked reports | `PROJECT_SUMMARY.md`, `docs/work-summary.md` |

Earlier agent snapshots that described PR #175 or the 4.3.0 finalization as in
flight are stale. Client merge is merged, and local `main` equals
`origin/main`.

### Codex implementation and pull-request work

- **PR #34 / issue #21:** implemented the version-consistency test.
- **PR #37 / issue #23:** enabled production-only Content Security Policy.
- **PR #42 / issue #6:** implemented same-column task reordering, rebased the
  branch, resolved its release conflict, validated it, and merged it.
- **PR #44 / issue #9:** implemented project sorting and preserved compatible
  Import-placeholder behavior while resolving concurrent conflicts.
- **PR #50 / issue #13:** added normalized global task tags and their API,
  including guarded deletion.
- **PR #53 / issue #26:** added GitHub Actions quality gates and verified both
  push and pull-request runs.
- **PR #54 / issue #16:** added transactional task checklist templates.
- **PR #55 / issue #47:** corrected client-slug synchronization and designed a
  backup-first, integrity-checked SQLite backfill.
- **PR #56 / issue #17:** authored the Campaign Playbook import-format
  specification, including exact workbook contracts, preview, conflict, and
  transaction rules.
- **PR #83 / issue #63:** implemented atomic dashboard refresh, retained stale
  data on failure, and added persistent retry feedback.
- **PR #86 / issue #65:** split the oversized React `App` into focused
  components while preserving its public entry point and tests.
- **PR #92 / issue #69:** added archived-client filtering and resolved
  concurrent version conflicts without discarding compatible UI work; the
  Windows teardown problem found during verification became issue #94.
- **PR #97 / issue #71:** fixed the Settings teardown race by cleaning up React
  before restoring global fetch, and added the Drive-status error state.
- **PR #117 / issue #104:** implemented SQLite WAL mode, a 5000 ms busy timeout,
  database-backed health checks, and idempotent HTTP/database shutdown. The
  delivery passed 563 unit/integration tests, typecheck, lint, formatting,
  build, version checks, backup/restore rehearsal, seven Playwright workflows,
  and required remote gates.
- **PR #121 / issue #112:** built the Signal planner UI around the established
  posts and queue APIs, reloading both schedule and queue state after writes.
- **PRs #122 and #123:** established merge order, rebased each card against the
  newly merged main, preserved compatible changes, finalized versions 3.0.1
  and 3.0.2, verified required gates, and merged both.
- **PR #127 / issue #108:** documented the full Google Drive OAuth exposure,
  the difference between token scope and local folder restrictions, incident
  revocation steps, and a future `drive.file` plus Google Picker migration.

### Codex reviews, diagnosis, and planning

- Performed the initial architecture and post-PR #1 verification of the
  React/Vite, Express, SQLite, Drive-provider, and Playwright boundaries.
- Reviewed E2E database isolation and confirmed that tests must use only
  `data/e2e.db` on dedicated non-reused servers.
- Diagnosed a stale displayed version as the branch and dev server actually
  running, not a browser-cache defect.
- Diagnosed Windows Playwright runs where scenarios passed but the npm,
  Playwright, server, or Vite wrapper remained alive. These were reported as
  teardown failures rather than falsely green E2E results.
- Reviewed cleanup of leaked E2E clients without deleting records. The proposed
  operational procedure required explicit approval, a timestamped backup,
  candidate review, one transaction, integrity checks, foreign-key checks, and
  no Drive mutation.
- Produced Version 3 and Version 4 feasibility and safety sequencing. The
  recommended order put loopback binding, valid dates, isolated E2E, and
  versioned migrations before schema-backed features, then separated Calendar,
  Files, Import, and cloud hosting into dependency-aware waves.
- Preserved Dropbox and other external planning documents as their own source
  of truth instead of copying absent material into the repository.

### Multi-agent governance and release coordination

- Populated GitHub Project 3 with Wave, numeric Release order, Release line, and
  Workstream fields across its 21 cards.
- Used readiness and dependency bands instead of a fixed weekly release train.
- Prepared vendor-neutral execution packets for Codex, Anthropic, Google, and
  other agents, including objectives, settled decisions, prerequisites,
  exclusions, contracts, security invariants, tests, rollback, stop conditions,
  branch names, and conflict risks.
- Established isolated worktrees and one branch/PR per card for concurrent
  agents, with explicit planning for shared release-file conflicts.
- Required rebasing on current `origin/main` before assigning a version and
  `--force-with-lease` when an already published branch had to be rewritten.
- Established that remote CI is green only after required push and PR checks
  finish; a bounded watch timeout is only a status snapshot.

### Product and security invariants carried forward

- SQLite owns operational records; Google Drive owns files.
- Local deletion, archiving, import, and client merge never delete or rename
  Drive content as a side effect.
- Google tokens stay encrypted on the server and never reach the browser.
- Drive browsing, `SignalProvider`, and Calendar remain read-only interfaces;
  their writes live behind separate services.
- Integration events are append-only, transactionally recorded, bounded, and
  scrubbed of credentials.
- Concurrent agents preserve unrelated checkout changes, stage explicit paths,
  and do not use `git add -A` in a mixed worktree.
- Draft PRs carry `changes/<issue>.md`; ready PRs contain the serialized version
  and changelog entry and no longer contain that card's fragment.
- The four release values must agree, and version advancement is checked against
  the current merge base so two cards cannot silently ship the same version.

### Handoff status

Codex has no uncommitted product change in this checkout. The project is on
`main` at 4.3.0 with client merge shipped. The remaining repository-level
process item observed by the other reports is the set of six merged-card
fragments under `changes/142.md` through `changes/147.md` that have not yet been
folded into dated `CHANGELOG.md` entries.

# Version 4 Sprint Feasibility and Release Report

Reviewed: 2026-08-11  
Source: `C:\Users\garni\Dropbox\GHD Deliverables\House\Version 4.md`  
Repository snapshot: `feat/24-task-tags-ui` at `f78ecb4` (`2.7.3`); local `main` is `87f2288` (`2.7.2`)

## Executive assessment

Version 4 is feasible, but it is not one sprint as currently written. It combines:

- three related dashboard defects that should ship first;
- several small workflow improvements, some of which already exist and need verification rather than new implementation;
- two schema-backed capabilities;
- three integration-scale modules; and
- a cloud-hosting decision that changes the application's security and data architecture.

The best near-term release is a **dashboard correctness milestone**. Follow it with a **workflow polish milestone**, then treat Calendar, Files, Import, and cloud hosting as separately scoped epics. Attempting all items in one release would create unnecessary regression and data-migration risk.

Indicative sizes used below:

- **S:** up to about two focused development days
- **M:** about three to five development days
- **L:** about one to two weeks
- **XL:** multiple sprints or an architecture program

These are planning ranges, not delivery commitments. They assume one implementer, review, tests, and documentation.

## Important current-state findings

1. **The task-editing paper-cuts are already implemented.** The existing task edit form and API update description, notes, start date, and due date. These four lines should become one verification/UX card, not four feature cards.
2. **Sidebar customization is partially implemented.** Settings already edit the mark, title, subtitle, and tagline. Color controls and a true image logo are not implemented.
3. **The dashboard's “Recently updated” data is project-centric.** It sorts `projects.updated_at`; editing a task, checklist, tag, or dependency does not make its parent project recent. This is the likely cause of the dashboard card appearing stale.
4. **The Projects “Recently updated” comparator is not a pure date sort.** It deliberately groups ACTIVE projects before every other status, then sorts within each group. If the intended behavior is newest activity regardless of status, the current test and implementation encode the wrong product rule.
5. **“Deadline watch” currently means overdue work only.** Due-today and next-seven-day items are returned as `upcomingTasks` and shown under “Coming up next”; the four metric cards are display-only. The implementation and the wording of the sprint item do not currently describe the same user experience.
6. **Dashboard task queries are not scoped to active clients/projects.** Archived work can still enter counts because the task repository joins all projects and clients. Correct scoping should be decided as part of the deadline fix.
7. **Cloud hosting is not a deployment-only change.** The app is intentionally loopback-bound, uses local SQLite, has no user authentication, assumes local secrets, and uses localhost OAuth/CORS defaults.

## Feasibility by sprint item

### Bugs

| Item | Feasibility / size | Recommendation and acceptance boundary |
|---|---:|---|
| Recently Updated project sort | High / S | First define whether “updated” means direct project edits or any project activity, and whether archived/on-hold projects participate. Remove the ACTIVE-first grouping if the label promises a pure timestamp sort. Add deterministic UI tests for equal timestamps and every status. |
| Dashboard Recently Updated card | High / M | Introduce explicit activity semantics. Prefer a computed `lastActivityAt` or a small activity service over silently reusing project `updated_at`. Task edits, checklist changes, dependency changes, and tags need a deliberate rule. Test the dashboard API and refresh behavior. |
| Deadline Watch, Due today, Next 7 days | High / M | Treat this as an end-to-end slice: fixed-clock domain tests, active/archived scoping, API counts/lists, empty states, and clickable metric cards that open matching board filters. Define whether “Next 7 days” excludes today (current server rule) or includes it (current board helper can include it). |

These three cards share `server/app.ts`, `client/src/App.tsx`, dashboard tests, and date rules. They should be sequenced, not developed concurrently in the same files.

### Infrastructure

| Item | Feasibility / size | Recommendation and acceptance boundary |
|---|---:|---|
| Lives in the cloud | Feasible, architecture-dependent / XL | Run a decision spike before implementation. Decide whether local SQLite remains authoritative, a hosted database becomes authoritative, or a private single-instance deployment preserves SQLite. A public web deployment requires authentication, authorization, HTTPS, CSRF/session design, hosted secrets, backups/restores, production OAuth redirects, data migration, and an explicit Drive-token threat model. Do not expose the current server by merely changing `HOST`. |

Suggested decision criteria:

- single-user versus future multi-user access;
- browser-only access versus installable desktop/native access;
- offline behavior and source of truth;
- operational ownership of backups and updates;
- acceptable recurring hosting cost;
- whether Google Drive access must continue when the user's computer is off.

A native/desktop package improves installation but does not make the data cloud-accessible. A private hosted single instance is the least disruptive web option; a managed multi-user web application is the most durable but requires the largest redesign.

### Paper-cuts

| Item | Feasibility / size | Recommendation and acceptance boundary |
|---|---:|---|
| Description editable after publishing | Already implemented / verification | Verify create, edit, clear-to-empty, reload, and responsive modal behavior. |
| Notes field on Tasks | Already implemented / verification | Verify create, edit, clear-to-empty, persistence, and whether notes should appear in task detail without opening Edit. |
| Start and Due dates editable after first save | Already implemented / verification | Verify valid date changes and clearing, plus timezone-safe display and dashboard recategorization after save. |

Combine these into one **Task details editing verification and polish** card. The likely improvement is visibility in the detail view, not persistence.

### Feature requests

| Item | Feasibility / size | Recommendation and acceptance boundary |
|---|---:|---|
| Categories on Projects | High / M | Requires a product decision and migration. Decide one category versus multiple, fixed versus user-managed values, and filter/report behavior. Use a normalized model if categories will be editable or reusable; avoid a hard-coded UI-only list. |
| Hide archived clients on stage; Active/Inactive filter | High / S | Default to Active, provide an explicit Archived/All view, retain direct-link handling, and keep archive rather than delete. Also decide whether projects/tasks under archived clients disappear from dashboards and selectors. |
| Alphabetize Dependencies dropdown | High / S | Sort case-insensitively by project name then task title, with a stable tie-breaker. Preserve circular-dependency prevention and exclude the current/already-linked task. |
| Breadcrumbs deeper than one level | High / M | Add a route-aware breadcrumb model for client, project, and task context. Avoid hand-building labels inside individual pages. |
| Clickable breadcrumbs | High / S after breadcrumb model | Use semantic links, preserve keyboard focus, and define the task destination because task detail is currently modal-driven rather than its own route. |
| Clickable Dashboard stage boxes | High / S-M | Link Active Clients and Active Projects to filtered lists; link Due Today and Next 7 Days to durable board query parameters. This should ship with the deadline fix so counts and destinations cannot disagree. |
| Calendar modal with Signal Campaign scheduler and Post Bridge/Buffer | Partial view: L; publishing integration: XL | Start with a read-only agenda/week view backed by existing due-date rules. Model scheduled content separately from task due dates. Then add one server-side social provider, idempotency keys, preview/confirmation, timezone handling, credential storage, retry/status reconciliation, and mock-provider tests. Do not dual-write to Post Bridge and Buffer in the first version. Both services currently publish scheduling APIs: [Post Bridge API](https://api.post-bridge.com/reference) and [Buffer API](https://developers.buffer.com/guides/introduction.html). |
| Files modal | High, but staged / L | Extend `DriveProvider`; start with paginated, read-only project-folder browsing and “Open in Drive.” Add upload/download later. Move/rename/delete require explicit confirmations and must preserve the rule that local record deletion never changes Drive files. A full page is likely more usable than a modal on smaller screens. |
| Import modal | High, requirements-dependent / L | Define supported input, mapping, validation report, duplicate policy, preview, transaction boundary, retry behavior, and an import receipt. Keep the existing placeholder until a format contract exists. Import must be idempotent or offer a safe rollback for newly created local records. |
| Custom sidebar colors and logo | Partial implementation / M | Retain existing text/mark settings. Add accessible palette controls with contrast validation. For image logos, decide local upload versus URL/Drive reference, validate file type/size, and ensure CSP/storage/backup behavior is documented. Always retain text alternatives and visible focus. |

## Recommended release cadence

Repository policy says every merged card receives a version bump, and the first closed card in a milestone takes the minor bump while later cards take patches. Therefore, the exact version number must be assigned at merge time; branch names should remain `<type>/<issue>-<slug>`.

Use a **twice-weekly planned release train**, with urgent regression patches allowed between trains. This is fast enough for a single-user application while leaving time for real usage feedback and database backup verification. A card may merge and release individually under the current policy; the “waves” below define sequencing and observation windows, not bundled version numbers.

### Wave 1: Dashboard correctness (about 3-5 working days)

1. Define updated/activity and archived-scope product rules.
2. Fix project sort semantics and tests.
3. Fix dashboard project activity behavior.
4. Fix deadline counts/lists and add clickable Due Today/Next 7 Days cards.
5. Observe at least one real working day before beginning schema changes.

Release gate: unit/integration tests, TypeScript, lint, production build, isolated E2E, fixed-clock date coverage, no archived leakage, and manual verification around local midnight.

### Wave 2: Workflow polish (about 1 week)

1. Task detail editing verification and display polish.
2. Active/Archived client visibility.
3. Alphabetized dependencies.
4. Route-aware, clickable breadcrumbs.
5. Remaining dashboard metric links.

These are mostly independent, but the breadcrumb and dashboard cards both touch the large `App.tsx`; merge them sequentially or extract shared navigation components first.

### Wave 3: Project organization (about 1 week)

1. Decide the category model.
2. Add the migration and repository/API behavior.
3. Add project form, chips/filtering, tests, documentation, and migration recovery checks.
4. Add sidebar palette/logo only after its asset-storage choice is settled.

### Epics after Wave 3

- **Calendar:** read-only task/project calendar first; social publishing later.
- **Files:** read-only Drive browsing first; mutating operations later.
- **Import:** contract and preview first; transactional writes second.
- **Cloud:** architecture decision record and threat model before implementation.

Do not run these epics concurrently without first splitting `client/src/App.tsx` and `server/app.ts`; both are shared conflict hotspots.

## Additional improvements to consider

1. **Create a project activity model.** This resolves both “Recently updated” issues and gives Calendar/Files/Import a safe place to record meaningful activity without corrupting entity timestamps.
2. **Centralize dashboard scope rules.** One query/service should define active clients, active projects, incomplete tasks, and deadline buckets so cards, lists, and board links cannot drift.
3. **Inject a clock into deadline calculations.** Fixed-clock tests should cover today, local midnight, daylight-saving transitions, empty dates, completed tasks, and archived parents.
4. **Fix E2E process cleanup.** The single Playwright scenario passed in 12 seconds during this review, but `npm.cmd run test:e2e` did not terminate and hit the 180-second command timeout. Make clean server shutdown a release-infrastructure card before treating E2E as a blocking CI gate.
5. **Split the large UI/API files incrementally.** Extract Dashboard, project sorting, task detail/form, breadcrumb navigation, and integration routes behind small service boundaries before parallel feature work.
6. **Add import/activity audit records.** Record what created or changed local data, when, and by which integration. This is especially important for retries and partial failures.
7. **Add backup/restore verification to migration releases.** Take a database backup, migrate a copy of an older database, reopen it, and verify existing Drive references before shipping schema changes.
8. **Use provider interfaces for external scheduling.** Keep credentials and vendor SDK/API calls server-side; use one mockable interface so Post Bridge or Buffer can be swapped without embedding vendor logic in React.
9. **Add visible “last refreshed” and refresh error states.** This makes dashboard freshness diagnosable and prevents a stale fetch from looking like incorrect sorting.
10. **Remove blank numbered placeholders from the sprint document or label them “TBD.”** Empty Bugs #4 and the trailing blank entries make scope and completion ambiguous.

## Decisions required before cards are written

1. Does “Recently updated” mean direct project edits, or any activity inside a project?
2. Should archived/on-hold projects ever appear in Recently Updated, dashboard counts, task selectors, or deadline lists?
3. Does “Next 7 days” include today, and should completed tasks be hidden everywhere?
4. Are project categories single-select or multi-select, fixed or user-managed?
5. Should task notes display in the task detail view, or remain edit-only/private working text?
6. Is the desired cloud outcome remote browser access, automatic backup, multi-device sync, or eventual multi-user collaboration?
7. For social scheduling, which system is authoritative: Signal Campaign, Post Bridge, or Buffer?
8. Is Files initially read-only, and are upload/move/rename/delete explicitly out of scope?
9. Which import format is first, and what constitutes a duplicate?

## Verification performed

- `npm.cmd test`: **87/87 passed**
- `npm.cmd run typecheck`: **passed**
- `npm.cmd run lint`: **passed**
- `npm.cmd run build`: **passed**
- `npm.cmd run test:e2e`: browser scenario **passed in 12.0s**, but the command failed to exit and the wrapper timed out at 180 seconds

No application or Dropbox data was changed during the review. This report is the only repository change.

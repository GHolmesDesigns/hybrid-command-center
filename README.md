# Hybrid Command Center

A local-first command center for a single creative director. **Clients, projects, and tasks live in SQLite** — Drive holds project files and is provisioned from the app. Folder names never create or own projects.

Built from Master Project Command Center (Codex) infrastructure, with Hybrid V2 sidebar, branding, sync, and delete/rename controls.

For nontechnical installation and day-to-day instructions, see the [First-Time Setup and User Manual](USER_MANUAL.md).

The Import module's versioned XLSX contract, pasted text form, and example campaigns are documented in the [Campaign Playbook Import Format](docs/campaign-playbook-import-format.md).

## What is included

- Deadline-led dashboard with overdue, due-today, seven-day (today included), and project-health counts, scoped to unarchived work and calculated by the same rules the board filters by
- **Sync to Folder** on the dashboard — provisions missing Drive folder skeletons for existing clients/projects; it uploads, downloads, and mirrors nothing, and never discovers projects from Drive
- Client creation, editing, archival, detail views, and Drive status
- Project creation, editing, archival, and **record-only delete** that cascades to tasks (Drive files untouched)
- Projects view with search, client filter, category filter, and seven sort modes, including a **Custom order** where tiles are rearranged by drag or keyboard and the arrangement persists
- Shared **project categories** — many per project, created from a project or from Settings, reused case-insensitively, filtered from the page address, renamed everywhere at once, and deleted with an affected-project count that never deletes a project
- Five-stage **Status** board with persistent ordering, drag-and-drop, filters, tag filtering, title/tag search, and keyboard status controls
- Shared **task tags** created straight from a task, reused case-insensitively, shown as named chips on cards, and deleted from Settings with an affected-task count
- Task checklists, dependency blocking, circular-dependency prevention, **rename**, inline description/dates/notes, **record-only delete**, and explicit completion override
- Optional **task type** for design-studio work — blog post, video, social post, graphics, scheduling, QA/brand pass, admin, or other — shown on the card and in the task detail
- **Edit details** on a task, opening the full create/edit form from the task detail view
- Collapsible sidebar with **version tracker** and Settings-editable branding — wording, colours, and an optional logo, with **WCAG AA contrast enforced** and every field resettable to the defaults in `shared/branding.ts`
- **Campaign playbook import** — an .xlsx workbook or pasted tabs creating a client, its projects, their tasks, checklists, and dependencies in one confirmed transaction, previewed first, duplicates skipped and reported, with a persisted receipt and no Drive side effect
- **Files** — read-only browsing of a project's Drive folder and its provisioned subfolders: paginated listing, type/size/modified for every item, and "Open in Drive" on every row. It uploads, downloads, moves, renames, and deletes nothing, and every Drive failure mode has its own state and next step
- **Integration activity** — an append-only record of what each integration changed, when, and how it ended, naming the affected clients, projects, and tasks by id, bounded to the most recent 200 rows, credential-scrubbed, and shown on the Import page beside the receipt it belongs to
- Reserved placeholder for the Calendar module — visible in the sidebar and Settings, not yet implemented
- Server-only Google OAuth 2.0, encrypted token storage, configurable Drive root, and resumable/idempotent folder creation
- Responsive desktop/tablet/mobile interface with empty, error, loading, disconnected, and confirmation states
- Optional realistic seed data that never contacts Drive unless explicitly requested

## Architecture

```text
client/                    React + TypeScript + Vite
  src/App.tsx              routes, views, forms, Status board interactions
  src/api.ts               typed HTTP boundary
server/                    Express local API
  domain/                  deadline and dependency rules
  drive/                   provider interface, Google implementation, provisioning + sync,
                           and read-only project folder browsing (browse.ts)
  scripts/                 migration, demo seed, backup, restore, and rehearsal
  backup.ts                SQLite online backup / restore helpers
  import.ts                campaign playbook import: plan, one transaction, receipt
  integration-log.ts       append-only integration activity records
  app.ts                   validated HTTP endpoints
  db.ts                    SQLite schema and transaction helper
shared/                    cross-layer types, workflow constants, branding defaults
e2e/                       Playwright critical-flow coverage
data/                      ignored local SQLite database and backups
```

The browser never receives Google tokens. UI code calls only the local API. Drive operations sit behind `DriveProvider` — including the Files module, which reads through it and never imports a Google SDK. Deadline calculations are reusable domain functions, leaving a clean boundary for future month/week/agenda calendar views.

### Data ownership

- **SQLite:** clients, projects, tasks, board-card and project-tile positions, checklists, dependencies, due dates, notes, task tags, project categories, settings, branding (including the sidebar palette and the logo's address, never the image itself), Drive IDs/URLs, provisioning steps, import receipts, integration activity records, and timestamps.
- **Google Drive:** every project file. The database stores references, never duplicate file contents. Deleting a project or task in the app does **not** delete Drive folders or files.

Timestamps are stored as UTC ISO strings. Date-only deadlines are interpreted in the browser/server machine's local timezone and become overdue after their local calendar day has passed.

## Prerequisites

- Node.js 24 or newer (the project uses the built-in `node:sqlite` module)
- npm 10 or newer
- A Google account and Google Cloud project only when enabling Drive

## Install and run

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:5173`. The local API listens on `http://localhost:8787`.

Commands:

```bash
npm run dev            # frontend and API with live reload
npm run build          # type check and production frontend build
npm start              # serve the production build and API
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run db:migrate
npm run db:seed
npm run db:backup
npm run db:restore -- <backup-file> --force
npm run db:backup:rehearse
```

`npm run db:seed` is safe: it creates local demo records only. To deliberately create Drive folders for seed records after OAuth and root-folder setup, run `npm run db:seed -- --with-drive`. Seed exits without changes if clients already exist.

## Google Drive setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Open **APIs & Services → Library**, find **Google Drive API**, and enable it.
3. Configure the OAuth consent screen. For an External app in testing, add your own Google account as a test user.
4. Under **APIs & Services → Credentials**, create an **OAuth client ID** with application type **Web application**.
5. Add `http://localhost:8787/api/drive/oauth/callback` as an authorized redirect URI.
6. Copy `.env.example` to `.env`, then add the client ID and secret.
7. Generate a long random encryption secret (at least 32 random bytes) and set `GOOGLE_TOKEN_ENCRYPTION_KEY`. This key protects OAuth tokens at rest; back it up separately.
8. Restart the app. Open **Settings → Google Drive → Connect Google Drive** and approve access.
9. Create or choose one existing Drive folder, paste its URL or ID into **Command Center root folder**, and save.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local API port; default `8787` |
| `HOST` | Interface the API binds to; default `127.0.0.1` (loopback only). Set `0.0.0.0` to expose it on the LAN — the app has no authentication, so do this deliberately |
| `DATABASE_PATH` | SQLite path; default `./data/command-center.db` |
| `APP_ORIGIN` | Vite/browser origin; default `http://localhost:5173` |
| `GOOGLE_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth web client secret |
| `GOOGLE_REDIRECT_URI` | Must match the Cloud Console URI exactly |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Local token-encryption secret |
| `LOG_LEVEL` | Structured API/Drive logging level |

Secrets, tokens, local databases, logs, and test artifacts are excluded by `.gitignore`.

### Production Content Security Policy

Production responses include a Content Security Policy. Scripts, API connections, images, media,
manifests, and workers are restricted to the application's own origin; objects and frames are
disabled. The two external sources are limited to the existing Google Fonts stylesheet
(`fonts.googleapis.com`) and font files (`fonts.gstatic.com`). Inline script is forbidden. Inline
style attributes remain allowed because React renders the task-progress width, the drag-and-drop
transform, and the sidebar palette as element styles. Automatic HTTP-to-HTTPS upgrading is disabled
because the packaged app is served on loopback HTTP by default.

Images are the one directive that accepts a remote origin (`img-src 'self' data: https:`), because
a sidebar logo is referenced by address and its host cannot be known in advance. See
[Sidebar branding](#sidebar-branding).

The policy is disabled during `npm run dev` because Vite's development client needs its hot-module
reload runtime. This exception does not apply to `npm start` or `NODE_ENV=production`.

### Sidebar branding

Branding lives in the `settings` table under the `branding` key and is edited in Settings: the
mark, title, subtitle, tagline, three colours, and an optional logo. Defaults are in
`shared/branding.ts`, and every field resets to them.

**Contrast is enforced, not suggested.** Sidebar text and the accent must each clear WCAG AA
(4.5:1) against the sidebar background. The form shows a live ratio and a Passes/Fails reading in
words for each pair and refuses to submit a failing one; `PUT /api/settings/branding` refuses it
again with the same shared rule, so no client can store a sidebar its own text cannot be read
against. Only those three colours are chosen. The mark's lettering, secondary label colour, hover
fill, hairlines, and the sidebar's focus ring are derived from them, which is what keeps secondary
text and the focus ring legible on any palette the API accepts.

**A logo is a reference, not an upload.** The field takes an `https://` address — a CDN, a
website, or a Drive image link — and the browser loads it directly. Nothing is uploaded, copied
into the database, or backed up, so this app still stores no user files: no upload endpoint, no
file-type or size validation, and no new material in the backup story. The cost is the CSP widening
above and a page load that reaches the logo's host. A logo requires alt text, and when the address
fails to load — or none is set — the text mark takes its place.

### Project categories

Categories label projects the way tags label tasks, one level up: a shared workspace list, many
per project, created by typing a name that is not there yet. They are normalized, not packed into
a column — a `categories` table and a `project_categories` join — which is what makes a single
rename reach every project carrying the category, and what keeps deletion a detachment rather
than a cascade into anyone's work.

- Names are matched case-insensitively and collapse inner whitespace, so `Retainer`,
  `retainer`, and `  Retainer ` are one category. The stored spelling is the one first entered,
  and the same rule (`normalizeCategoryName` in `shared/types.ts`) is used by the API and the
  chip input, so a name typed in the browser resolves to the category the server would match.
- The Projects page carries its category selection in the page address, as the board carries its
  filters, so a filtered view survives a reload and can be shared as a link. Selecting more than
  one category shows the projects carrying every one of them.
- `DELETE /api/categories/:id` refuses with `409 CATEGORY_IN_USE` and an `attachedProjectCount`
  while the category is attached; `?confirm=true` then detaches it everywhere. No project is
  deleted or otherwise changed, and the join rows also cascade on their own if a project is
  deleted.
- Attaching or detaching a category counts as an edit of the project record — the same kind of
  change as a rename — so it moves `updated_at` and `last_activity_at` together.

The migration is additive: an existing database gains two empty tables and opens with every
project intact and uncategorized.

### Campaign playbook import

`/import` imports a campaign playbook — an .xlsx workbook, or the same tabs pasted as
tab-separated text — into clients, projects, tasks, checklist items, and dependencies. The format
is specified in [`docs/campaign-playbook-import-format.md`](docs/campaign-playbook-import-format.md),
with a sample workbook in `docs/examples/`.

- **Preview first.** `POST /api/import/playbook/preview` is read-only and reports what would be
  created, what is already here, and every validation error with its tab, row, and column. The
  confirm button is enabled only for a clean preview.
- **One transaction.** `POST /api/import/playbook` re-reads the file, re-plans against the
  workspace as it stands, and writes everything or nothing (`transaction(db, …)`). The commit
  carries the fingerprint its preview returned, so a file edited in between is refused rather
  than imported against a stale preview.
- **Duplicates are skipped, never merged.** A client matches on name, a project on name within
  its client, a task on title *and* due date within its project — all case-insensitively,
  archived records included. Matched records are attached to, never edited, which is what makes
  re-importing the same playbook create nothing the second time.
- **Receipts persist.** Every import writes an `import_receipts` row — counts created, skipped,
  and failed, with every reason — listed on the Import page after the modal closes and pruned to
  the most recent 50. A failed write rolls back; its receipt is written outside the transaction
  so the failure stays diagnosable.
- **Every import is audited.** The same write leaves one `integration_events` row naming the
  records it created by id — see **Integration activity** below.
- **No Drive side effect.** Imported clients and projects are stored `DISCONNECTED` and are
  provisioned the next time **Sync to Folder** runs.

The workbook is read without a spreadsheet dependency: `server/domain/workbook.ts` unzips the
XLSX with `node:zlib` and reads the small subset of SpreadsheetML the format allows, refusing
macros, encryption, formulas, merged data cells, hidden rows, and Excel date serials. The rules
themselves are database-free in `server/domain/playbook.ts`, so the same plan builds the preview
and the write. The migration is additive: an existing database gains one empty table.

### Integration activity

`integration_events` is the audit half of every integration: one row per operation an integration
ran against local data, so a partial import or a failed sync is diagnosable without opening the
database. The importer writes it today; a calendar sync will write it next. It is listed on the
Import page under **Integration activity**, and each import receipt names the record it was
written with.

- **What a row holds.** The source (`campaign-playbook`, later `signal-campaign` or
  `google-drive`), the operation (`playbook.import`, `calendar.sync`, `drive.sync`), the outcome
  — `SUCCESS`, `PARTIAL`, or `FAILURE` — a one-line summary in counts, the ids and labels of the
  clients, projects, and tasks it affected, the error text when it failed, and the id of the
  record it explains (`correlation_id`, an import receipt today).
- **Append-only.** `server/integration-log.ts` has one `INSERT` and the retention `DELETE` in it,
  and no update. `GET /api/integrations/activity?source=&correlationId=&limit=` is the only route
  that touches the table; nothing writes it from the browser. Rows come from the services doing
  the work.
- **`PARTIAL` is the point.** An operation that writes in steps has to be able to say that some
  of it landed and name which — that is what makes a half-finished operation diagnosable. An
  import cannot report it, because it is one transaction: a refused or rolled-back import is a
  `FAILURE` that left nothing, and its error text says which row or which write refused.
- **Bounded, and documented as such.** The newest **200 rows** are kept, older ones pruned as new
  ones are written; one row lists at most **100 affected records**, with the true number kept in
  `entity_count`. An `error` is scrubbed of anything credential-shaped and truncated to 500
  characters, so no token, key, or password can reach a table the app treats as readable.
- **No foreign keys, on purpose.** An event has to stay readable after the client, project, or
  task it names is deleted, which is exactly the case it exists for — so it stores the label the
  record carried alongside its id.

The migration is additive: an existing database gains one empty table and two indexes.

### Drive provisioning behavior

Client creation ensures `[Root]/[Client Name]`. Project creation ensures the project folder and the five configured subfolders from `server/config.ts`:

```text
01_Admin/
02_Briefs/
03_Working_Files/
04_Review/
05_Final_Deliverables/
```

Every folder receives a stable Command Center idempotency property. Folder IDs—not names—are saved locally. Project-root IDs and each completed subfolder step are committed as soon as Drive confirms them. A retry resumes incomplete work, checks the same idempotency keys, and cannot silently duplicate folders. Renaming a local client or project deliberately does not rename the Drive folder; a future explicit confirmation flow can add that operation safely.

Expired access tokens refresh through Google's OAuth client. Revoked access produces a visible failed status and a retry path; reconnect in Settings if authorization was revoked.

### Files — read-only Drive browsing

`/files` browses the Drive folder behind a project. It is a page rather than a modal because a
paginated list with a folder switcher is cramped in a dialog, and because the project and folder
both belong in the address: `/files?project=<id>&folder=<id>` reloads and shares as it looks.
A project's detail page links to it, and the Drive folder itself is one click from every row.

- **Read-only by construction.** The UI has no upload, download, move, rename, or delete
  control, and there is no endpoint behind it that would accept one. The provider gained exactly
  one method, `listFiles`, and `server/drive/browse.ts` — the only module the route calls — has
  no write in it.
- **One endpoint.** `GET /api/projects/:id/files?folderId=&pageToken=&pageSize=` answers with
  `{ state, projectId, projectName, folder, scopes, files, nextPageToken, error }`. No token,
  credential, or Drive SDK object crosses it; the client never imports `googleapis`.
- **Scoped by ID.** A project is browsable at its own Drive folder and the subfolders recorded
  in `drive_steps` for it, matched by ID and never by name. Any other folder ID is refused with
  a 400 rather than fetched, so a folder ID in the address bar cannot turn one project's file
  list into a browser for the whole connected account. Folders deeper than that open in Drive.
- **Five states, five next steps.** `NOT_CONFIGURED` (no credentials in `.env`),
  `NOT_CONNECTED` (credentials but no connection), `NO_FOLDER` (this project has not been
  provisioned yet), `FAILED` (Drive was asked and refused — its own words, plus a retry), and
  `READY`, which includes a folder that is genuinely empty.
- **Paging is forward-only**, as Drive's cursor is: "Show 25 more" appends to the list rather
  than replacing it, and a reply that arrives after the selection changed is dropped.

## Tests

Run all automated checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install chrome  # once per machine; the config runs the Chrome channel
npm run test:e2e
```

Every one of these runs as a blocking gate in `.github/workflows/quality-gates.yml`. `npm run test:e2e` starts and stops its own API and Vite servers, on ports 8788 and 5174, against `data/e2e.db`, which is deleted at the start of every run; it exits on its own whether the suite passes or fails.

The tests use an in-memory SQLite database and a mock Drive provider. They never contact or modify a real Google Drive account. Coverage includes client/project/task creation, status movement and ordering, local-time deadline rules, checklist progress, dependency blocking and cycle prevention, hierarchy naming, idempotency, partial failure recovery, and dashboard counts. Playwright exercises the visible create-client → create-project → create-task → checklist workflow, and the dashboard deadline tiles round trip: clicking one opens the board filtered to exactly the tasks that tile counted. API integration coverage exercises dependency blocking and dashboard updates deterministically.

## Backup and recovery

Do not copy `data/command-center.db` while the app is running. SQLite may be using neighboring `-wal` and `-shm` files, and a naked copy of the main file is not a consistent snapshot.

Use the scripted backup instead. It calls SQLite's online backup API, so committed WAL/journal pages are included in one timestamped file under `data/backups/` (gitignored):

```bash
npm run db:backup
```

Restore requires the app to be stopped. The previous database is saved beside the backup first:

```bash
# stop npm run dev / npm start first
npm run db:restore -- data/backups/command-center-<timestamp>.db --force
npm run db:migrate
```

Before a schema migration release, rehearse against a *copy* of the backup (the live database is only read):

```bash
npm run db:backup:rehearse
```

Keep `GOOGLE_TOKEN_ENCRYPTION_KEY` with the backup; encrypted Drive tokens in SQLite cannot be read without it. Folder IDs and URLs survive restore on their own. Google Drive files require no local backup from this app; use Google's export/retention tools according to your own policy.

If `.env` sets `DATABASE_PATH`, pass the same path with `--database`. Write backups elsewhere with `--dir`.

## Troubleshooting

- **Drive says credentials required:** complete all four Google values in `.env` and restart.
- **Redirect URI mismatch:** make the Cloud Console URI and `GOOGLE_REDIRECT_URI` byte-for-byte identical.
- **Drive access revoked:** disconnect and reconnect from Settings, then use the retry action on failed records.
- **Root folder rejected:** paste a folder URL containing `/folders/…` or the folder ID itself, and confirm the connected account has access.
- **A project shows Drive issue:** the local record remains valid. Retry provisioning; completed steps are reused.
- **Database cannot open:** confirm the process can write to `data/`, or set an absolute `DATABASE_PATH`.
- **Port already in use:** change `PORT`, and update the Vite proxy if using a non-default API port.

## Current MVP limitations

- Single local user; no collaboration, portals, permissions, billing, or time tracking
- No automatic Drive-folder rename after local name edits
- Clients can only be archived; there is no client delete. Projects and tasks delete permanently from SQLite with no in-app undo — recover from a database backup
- **Sync to Folder** provisions folder skeletons only; there is no file-level Drive sync, and nothing is uploaded, downloaded, or mirrored
- Google shared-drive-specific controls are not exposed
- The file browser is read-only by decision, not by omission: it lists and opens, and there is no upload, download, move, rename, or delete in the UI or in the API surface behind it. A project is browsable only at its own Drive folder and the subfolders provisioning recorded for it; anything deeper opens in Drive
- Calendar views are intentionally not implemented
- Playbook import is create-only: it never edits or merges into a record that already exists, and there is no in-app undo of an import beyond deleting what it created
- Integration activity is bounded rather than permanent: the newest 200 records are kept and each lists at most 100 affected records, so it is a diagnostic log, not a compliance archive. Keep a database backup if a longer history matters
- Checklist reordering is supported by the API/data model; the current UI focuses on add, edit-by-state, and removal

## Planned extension points

**Calendar:** add `/calendar` and a calendar service that consumes task due dates and project milestones through the existing deadline domain functions. Month, week, and agenda components should remain clients of that service. Optional Google Calendar sync belongs in a separate provider beside Drive, not in task components. Every sync attempt should record to `integration_events` through `recordIntegrationEvent` — a sync that reads some sources and fails on one is the `PARTIAL` case the log was shaped for.

**Files:** `/files` has shipped read-only — `DriveProvider.listFiles` plus `server/drive/browse.ts` and the `GET /api/projects/:id/files` boundary. Extending it means adding upload/download/move/rename/search methods to the provider and a write path beside `browse.ts`, which stays read-only; a mutation belongs in its own module with its own confirmation flow. Continue storing only Drive IDs and metadata locally. UI components should never import `googleapis`.

Recommended order: (1) agenda/calendar read views and milestone model, (2) recent-files and cross-project search over the existing listing, (3) uploads/downloads, (4) guarded move/rename operations, (5) optional Calendar sync.

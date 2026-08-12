# Hybrid Command Center

A local-first command center for a single creative director. **Clients, projects, and tasks live in SQLite** — Drive holds project files and is provisioned from the app. Folder names never create or own projects.

Built from Master Project Command Center (Codex) infrastructure, with Hybrid V2 sidebar, branding, sync, and delete/rename controls.

For nontechnical installation and day-to-day instructions, see the [First-Time Setup and User Manual](USER_MANUAL.md).

The future Import module's versioned XLSX contract and example campaigns are documented in the [Campaign Playbook Import Format](docs/campaign-playbook-import-format.md).

## What is included

- Deadline-led dashboard with overdue, due-today, seven-day (today included), and project-health counts, scoped to unarchived work and calculated by the same rules the board filters by
- **Sync to Folder** on the dashboard — provisions missing Drive folder skeletons for existing clients/projects; it uploads, downloads, and mirrors nothing, and never discovers projects from Drive
- Client creation, editing, archival, detail views, and Drive status
- Project creation, editing, archival, and **record-only delete** that cascades to tasks (Drive files untouched)
- Projects view with search, client filter, and seven sort modes, including a **Custom order** where tiles are rearranged by drag or keyboard and the arrangement persists
- Five-stage **Status** board with persistent ordering, drag-and-drop, filters, tag filtering, title/tag search, and keyboard status controls
- Shared **task tags** created straight from a task, reused case-insensitively, shown as named chips on cards, and deleted from Settings with an affected-task count
- Task checklists, dependency blocking, circular-dependency prevention, **rename**, **record-only delete**, and explicit completion override
- Optional **task type** for design-studio work — blog post, video, social post, graphics, scheduling, QA/brand pass, admin, or other — shown on the card and in the task detail
- **Edit details** on a task, opening the full create/edit form from the task detail view
- Collapsible sidebar with **version tracker** and Settings-editable branding (defaults also in `shared/branding.ts`)
- Reserved placeholders for the Calendar, Files, and campaign playbook **Import** modules — visible in the sidebar and Settings, not yet implemented
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
  drive/                   provider interface, Google implementation, provisioning + sync
  scripts/                 migration and demo seed commands
  app.ts                   validated HTTP endpoints
  db.ts                    SQLite schema and transaction helper
shared/                    cross-layer types, workflow constants, branding defaults
e2e/                       Playwright critical-flow coverage
data/                      ignored local SQLite database
```

The browser never receives Google tokens. UI code calls only the local API. Drive operations sit behind `DriveProvider`, leaving a clean boundary for the future embedded file browser. Deadline calculations are reusable domain functions, leaving a clean boundary for future month/week/agenda calendar views.

### Data ownership

- **SQLite:** clients, projects, tasks, board-card and project-tile positions, checklists, dependencies, due dates, notes, settings, branding, Drive IDs/URLs, provisioning steps, and timestamps.
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
style attributes remain allowed because React renders the task-progress width and drag-and-drop
transform as element styles. Automatic HTTP-to-HTTPS upgrading is disabled because the packaged
app is served on loopback HTTP by default.

The policy is disabled during `npm run dev` because Vite's development client needs its hot-module
reload runtime. This exception does not apply to `npm start` or `NODE_ENV=production`.

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

## Tests

Run all automated checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install chromium  # once per machine
npm run test:e2e
```

The tests use an in-memory SQLite database and a mock Drive provider. They never contact or modify a real Google Drive account. Coverage includes client/project/task creation, status movement and ordering, local-time deadline rules, checklist progress, dependency blocking and cycle prevention, hierarchy naming, idempotency, partial failure recovery, and dashboard counts. Playwright exercises the visible create-client → create-project → create-task → checklist workflow; API integration coverage exercises dependency blocking and dashboard updates deterministically.

## Backup and recovery

Stop the app, then copy `data/command-center.db` and the `GOOGLE_TOKEN_ENCRYPTION_KEY` from your private environment backup. SQLite may create `-wal` and `-shm` files while running, so do not copy only the main database during active writes. Google Drive files require no local backup from this app; use Google's export/retention tools according to your own policy.

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
- The file browser and calendar views are intentionally not implemented
- Checklist reordering is supported by the API/data model; the current UI focuses on add, edit-by-state, and removal

## Planned extension points

**Calendar:** add `/calendar` and a calendar service that consumes task due dates and project milestones through the existing deadline domain functions. Month, week, and agenda components should remain clients of that service. Optional Google Calendar sync belongs in a separate provider beside Drive, not in task components.

**Files:** add `/files`, expand `DriveProvider` with list/upload/download/move/rename/search methods, and build client/project-scoped browser views. Continue storing only Drive IDs and metadata locally. UI components should never import `googleapis`.

Recommended order: (1) agenda/calendar read views and milestone model, (2) paginated Drive folder browsing and recent files, (3) uploads/downloads, (4) guarded move/rename operations and search, (5) optional Calendar sync.

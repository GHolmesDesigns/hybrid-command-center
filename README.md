# Hybrid Command Center

A local-first command center for a single creative director. **Clients, projects, and tasks live in SQLite** — Drive holds project files and is provisioned from the app. Folder names never create or own projects.

Built from Master Project Command Center (Codex) infrastructure, with Hybrid V2 sidebar, branding, sync, and delete/rename controls.

For nontechnical installation and day-to-day instructions, see the [First-Time Setup and User Manual](USER_MANUAL.md).

Released versions and what changed in each are recorded in the [Changelog](CHANGELOG.md).

The Import module's versioned XLSX contract, pasted text form, and example campaigns are documented in the [Campaign Playbook Import Format](docs/campaign-playbook-import-format.md).

Signal Campaign can tailor a post per platform and per account, preview what each target would receive, and explicitly submit scheduled social posts through an optional Post Bridge integration. [Publishing Integration](docs/publishing-integration.md) records its provider boundary, the content-variant inheritance, the scheduling conversion, and why delivery state remains separate from `PUBLISHED`.

Nothing in this app is reachable off loopback by design, and the server enforces that itself: a `HOST` outside `127.0.0.1`, `::1`, and `localhost` fails the boot while there is no authentication to put in front of it. The cloud decision and **AWS production runtime contract** — access model, EC2+Caddy+EBS shape, trusted proxy hops, SSM secret names, S3 backups, and staged account prerequisites — are in [Cloud Hosting](docs/cloud-hosting.md). Operator authentication, the production runtime package, and hosted backups are shipped (C51–C54); C114 enforces login when the production checklist is complete even with `HOST=127.0.0.1` behind Caddy. The [cutover runbook](docs/cloud-cutover-rehearsal.md) covers disposable staging rehearsal (C55) and the production cutover checklist (C115) — live DNS, secrets, and data moves stay operator-owned.

If IDE agents should plan Signal and workspace work through MCP, read [Multi-Agent MCP](docs/multi-agent-mcp-decision.md) first. It chooses a local stdio server over Signal — not a provider MCP wrapper — keeps provider publishing on the human-confirmed UI path, and defers any network MCP endpoint until operator authentication ships. For agents handing work to each other through the workspace, see [Agent Coordination Hub](docs/agent-coordination-plan.md) (C109 decided; C110–C112 implement handoffs). Coordination tools ship via `npm run mcp` (set `MCP_AGENT_LABEL` for writes); operators cancel stuck handoffs under **Agents → Agent handoffs**. The broader workspace/Signal MCP surface remains MCP-C106–C108.

## What is included

- Deadline-led dashboard with overdue, due-today, seven-day (today included), and project-health counts, scoped to unarchived work and calculated by the same rules the board filters by
- **Sync to Folder** on the dashboard — provisions missing Drive folder skeletons for existing clients/projects; it uploads, downloads, and mirrors nothing, and never discovers projects from Drive
- Client creation, editing, archival, detail views, and Drive status
- **Merge one client into another** — a previewed, confirmed, single-transaction move of every project from a duplicate client to the client you are keeping. The source is archived and recorded as merged, never deleted; each of the six contact fields is chosen field by field — keep the survivor's, take the duplicate's, or type a value — with the survivor's own the default for every one of them; no Drive folder moves; and a later playbook naming the merged client resolves to the survivor. There is no undo
- Project creation, editing, archival, and **record-only delete** that cascades to tasks (Drive files untouched)
- Projects view with grid or list presentation, search, client filter, live-status multi-filter, category filter, and seven sort modes, including a **Custom order** where grid tiles are rearranged by drag or keyboard and the arrangement persists
- Shared **project categories** — many per project, created from a project or from Settings, reused case-insensitively, filtered from the page address, renamed everywhere at once, and deleted with an affected-project count that never deletes a project
- Five-stage **Status** board with persistent ordering, drag-and-drop, client/project/priority/task-type/focus filters carried in the page address, tag filtering, title/tag search, and keyboard status controls
- Shared **task tags** created straight from a task, reused case-insensitively, shown as named chips on cards, and deleted from Settings with an affected-task count
- Task checklists, dependency blocking, circular-dependency prevention, **rename**, inline description/dates/notes, **record-only delete**, and explicit completion override
- Optional **task type** for studio work — blog post, video, social post, graphics, scheduling, QA/brand pass, admin, dev work, or other — shown on the card and in the task detail
- **Edit details** on a task, opening the full create/edit form from the task detail view
- Collapsible sidebar with **version tracker** and Settings-editable branding — wording, colours, and an optional logo, with **WCAG AA contrast enforced** and every field resettable to the defaults in `shared/branding.ts`
- **Campaign playbook import** — an .xlsx workbook or pasted tabs creating a client, its projects, their tasks, checklists, and dependencies in one confirmed transaction, previewed first, duplicates skipped and reported, with a persisted receipt and no Drive side effect
- **Files** — read-only browsing of a project's Drive folder and its provisioned subfolders: paginated listing, type/size/modified for every item, and "Open in Drive" on every row. It uploads, downloads, moves, renames, and deletes nothing, and every Drive failure mode has its own state and next step
- **Integration activity** — an append-only record of what each integration changed, when, and how it ended, naming the affected clients, projects, and tasks by id, bounded to the most recent 200 rows, credential-scrubbed, and shown on the Import page beside the receipt it belongs to
- **Signal Campaign** — the authoritative store and operable planner for content: month grid, unscheduled queue, quick idea capture, and a full editor for content, channels, ordered media references — public URLs and version-bound Drive files — date, time, format, planning status, lifecycle, delivery provenance, campaigns, and CTA, with duplicate-to-queue, next-open-slot suggestion, and confirmed Retire plan
- **Queue health** — an in-app summary above the planner deriving seven alerts from your own posts, deliveries, and the last inventory read: a failed or partly delivered post, a manual finish waiting on you, a scheduled slot approaching with nothing submitted, a provider answer that moved at the last check, a channel with nothing planned inside a configurable window, a provider synchronisation that is rate-limited or behind, and posts at the provider that this app did not send. Each line links to the post it is about, and acknowledging one changes no planning or delivery state. In-app only — no email, SMS, or push service
- **Figures** — the platforms’ own counts for a post that went out: provider-reported views, likes, comments, and shares per delivery, with the daily snapshots behind them shown as per-day gains, the time of the last synchronisation, and a refresh that runs only when you press it. A channel this provider does not measure says **Not available from this provider** rather than showing a zero, a rate-limited provider is waited out rather than hammered, and a refresh that fails leaves the last known good figures on screen. Where the provider says how it matched a record to the content on the platform, that is shown as **Provider match** beside the platform’s own identifier — provenance about *which content was measured*, with a sentence saying it neither qualifies nor discounts the counts, and nothing at all where the provider said nothing
- **Provider inventory** — a read-only panel below the planner listing what Post Bridge is holding, marking each row as sent from here or not: its state, when it goes out, which accounts it names, and a link out where the provider supplies one. It refreshes only when you press it, reads every page before it stores anything, and replaces the whole inventory in one step or replaces nothing and says why. It cannot adopt, edit, reschedule, or withdraw a post the app did not send — the point is that such a post stops being invisible before it collides with a slot the planner shows as empty
- **Signal campaigns** — a shared vocabulary labelling Signal posts the way categories label projects: a post carries as many as it needs, two spellings of one name are one campaign, renaming one reaches every post in a single write, and deleting one detaches it without deleting a post. Managed in Settings or typed straight into a post
- **Campaign figures** — the platforms' own counts added up per campaign, below the planner: totals, a compact daily trend, and filters for campaign, channel, account, and date range, with several campaigns read as *or*. Every group says how many of its deliveries are measured beside its total, a group with nothing measured says so rather than showing zeros, unclassified posts stay visible under **No campaign**, and the panel contacts no provider — it reads the figures a post's own refresh already stored
- **Calendar** — a read-only month agenda putting Signal's scheduled content beside task due dates, kept as two headed groups rather than one merged list of "events", with empty days dropped. It writes nothing, and a schedule it cannot read degrades the page to task due dates alone with the reason shown
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
  signal/                  Signal Campaign's schedule: SignalProvider (provider.ts), the
                           read-only implementation (read.ts), writes (service.ts), the campaign
                           vocabulary (campaigns.ts), and the queue-health summary's gathering
                           half (queue-health.ts)
  scripts/                 migration, demo seed, backup, restore, and rehearsal
  backup.ts                SQLite online backup / restore helpers
  calendar.ts              the read-only calendar: schedule and due dates over one range
  import.ts                campaign playbook import: plan, one transaction, receipt
  integration-log.ts       append-only integration activity records
  app.ts                   validated HTTP endpoints
  db.ts                    SQLite schema and transaction helper
shared/                    cross-layer types, workflow constants, branding defaults
e2e/                       Playwright critical-flow coverage
data/                      ignored local SQLite database and backups
```

The browser never receives Google tokens. UI code calls only the local API. Drive operations sit behind `DriveProvider` — including the Files module, which reads through it and never imports a Google SDK. Signal Campaign's schedule sits behind `SignalProvider` the same way, and that interface has no write method by construction, so the calendar reading through it cannot reach a change to a schedule. The planner writes through the separate Signal service. Deadline calculations are reusable domain functions, which is what let the calendar compose due dates and scheduled content without either module knowing about the other.

### Data ownership

- **SQLite:** clients, projects, tasks, board-card and project-tile positions, checklists, dependencies, due dates, notes, task tags, project categories, client merge aliases, Signal Campaign's planned posts, channels, campaigns, ordered media references (public URLs, and Drive file ids with their version fingerprints), and per-platform and per-account content overrides, settings, branding (including the sidebar palette and the logo's address, never the image itself), Drive IDs/URLs, provisioning steps, import receipts, integration activity records, and timestamps.
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
npm run mcp                 # local stdio MCP (coordination tools; set MCP_AGENT_LABEL for writes)
npm run db:migrate
npm run db:seed
npm run db:backup             # add -- --keep <n> to prune older snapshots
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
9. Select **Choose root folder with Google Picker** and pick the Command Center root. The
   folder id Google returns is stored; names alone are never enough.

### Drive OAuth scope and exposure

The connection requests `https://www.googleapis.com/auth/drive.file`, which grants access only
to files and folders the app created or the operator explicitly selected in Google Picker.
Files browsing remains restricted further to a project's own Drive folder and its recorded
subfolders. Anyone who steals the stored token still cannot reach arbitrary Drive content the
operator never selected.

Production cutover from an earlier full-Drive grant: disconnect in Settings, revoke the app in
[Google Account permissions](https://myaccount.google.com/permissions), then reconnect and
re-select the root with Picker. Restoring an old token ciphertext is not a scope migration.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local API port; default `8787`. A port number, 1–65535 |
| `HOST` | Interface the API binds to; default `127.0.0.1`. Loopback (`127.0.0.1`, `::1`, `localhost`) stays passwordless. Any other value requires the full §5.1 checklist — `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, https `APP_ORIGIN`, `PRODUCTION_TLS_TERMINATED=true`, and an explicit `TRUSTED_PROXY_HOPS` — or the boot stops; see [Cloud Hosting](docs/cloud-hosting.md) §5.1 |
| `DATABASE_PATH` | SQLite path; default `./data/command-center.db` |
| `APP_ORIGIN` | Vite/browser origin; default `http://localhost:5173`. An http or https URL, scheme included |
| `GOOGLE_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth web client secret |
| `GOOGLE_REDIRECT_URI` | Must match the Cloud Console URI exactly. `http://localhost` or `127.0.0.1` on `/api/drive/oauth/callback`, or `https://…` on that same path — no query or hash |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Local token-encryption secret; at least 32 characters |
| `GOOGLE_API_KEY` | Browser Picker developer key; restrict by HTTP referrer in Cloud Console |
| `GOOGLE_APP_ID` | Numeric Google Cloud project number (Picker `setAppId`) |
| `POST_BRIDGE_API_KEY` | Optional Post Bridge API key; server-side only |
| `PUBLISH_TIMEZONE` | Required with publishing; an explicit IANA zone such as `America/New_York` |
| `BUFFER_API_KEY` | Optional Buffer GraphQL API key; server-side only; refreshes TikTok and YouTube account metadata. Runtime writes remain fail-closed until the dated owner-run C83 round trip is recorded |
| `BUFFER_KEY` | One-release migration alias for `BUFFER_API_KEY`; ignored when the canonical setting is present |
| `BUFFER_ORGANIZATION_ID` | Optional Buffer organization id when the account has more than one organization |
| `LOG_LEVEL` | Structured API/Drive logging level: `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, or `silent`. An unrecognized value falls back to `info` |

The environment is validated when the server starts, and every problem is reported at once,
naming the variable and what was wrong with it — a rejected value is never printed back, because
two of these are secrets. A value the schema refuses stops the boot rather than surfacing later as
a CORS failure, a redirect mismatch, or a server listening on a port nobody chose. `LOG_LEVEL` is
the one exception: an unrecognized level falls back to `info`, since a typo there should not stop
the app.

The three Google values are optional together — leave them blank and the app runs with Drive
reporting itself unconfigured. What is refused is a value that is *present* and unusable, which is
why the encryption key has a minimum length: it is hashed into an AES-256 key, so a short secret
produces ciphertext that looks exactly as encrypted as a strong one.

Secrets, tokens, local databases, logs, and test artifacts are excluded by `.gitignore`.

### API error responses

A `400` or a `409` answers with the message the interface shows — a validation failure, a name
already taken, an import that could not be read. Those messages exist to be read, and the import
modal shows them verbatim.

A `500` does not. It answers with a fixed message and an `errorId`, and the real error — whatever
SQLite or googleapis said, table names and absolute paths included — goes to the server log against
that same ID. A user reporting "something went wrong" can quote the ID, and the log has the rest.

An unmatched path under `/api` answers `404` with a JSON body, ahead of the static client. A typo
in a client-side request reads as the 404 it is rather than arriving as `index.html` with a `200`.

A `413` answers a body over the parser's limit, a `429` a spent request budget, and a `503` an
import that arrived while another was running — see [Request budgets](#request-budgets).

### Request budgets

The API requires an operator session when the production checklist is complete
(`docs/cloud-hosting.md` §5.1 / §11), including the loopback-behind-Caddy shape. Incomplete local
config stays passwordless on loopback, which is why day-to-day development needs no login. A
hosted origin must satisfy that checklist before listen, and then every application route needs
the session cookie (and CSRF on mutations). The routes that cost real memory, CPU, or Google's
quota also carry a ceiling so a public origin does not publish an unbounded import or Drive walk.

There is deliberately **no global limiter**. The board is used interactively — a drag reorders
several tasks, opening a project reads its tasks and its files — and one bucket over every route
would throttle ordinary browsing long before it inconvenienced a loop. What is metered is import
and Drive:

| Routes | Budget | Why |
| --- | --- | --- |
| `POST /api/import/playbook`, `POST /api/import/playbook/preview` | 12 per 5 minutes, and one at a time | The only routes that read megabytes and then plan the whole workspace per request |
| `POST /api/drive/sync` | 4 per minute | One sync walks every client and project, so it costs a multiple of any other Drive call |
| `/api/drive/*`, `/api/settings/drive/*`, `GET /api/projects/:id/files`, the two `retry-drive` routes | 120 per minute, shared | They spend one Google account's quota, and two a second covers clicking through folders as fast as a person can |
| Everything else — clients, projects, tasks, tags, categories, Signal, the calendar, import receipts | unmetered | Ordinary interactive use, and local rows only |

Windows are counted per client address and answered with a `429`, a `Retry-After`, and a message
naming which budget was hit. The counting is a fixed window in memory, tracking a bounded number
of addresses; there is no store and nothing survives a restart, which is the right size for one
operator on one host.

The import routes also carry a **concurrency cap of one**, and both it and the rate limit are
mounted ahead of the body parser. That ordering is the point: a limiter that runs after
`express.json` has already buffered a 12 MB body has metered nothing, so a refused caller never
gets its body read. A second import while one is running is answered `503`.

The body limit for those routes is derived from the caps the Zod schema puts on the fields —
about 12 MB, the base64 workbook cap plus its JSON envelope — rather than the round 16 MB it
replaced, which sat 4 MB above anything the schema could accept. Every other route keeps 1 MB.

`headersTimeout` and `requestTimeout` are set on the server, which Express does not do and whose
Node defaults are minutes long. They bound how long a client may take to send headers and a whole
request, so connections cannot be held open with no request to show for them.

**This is not authentication, and it does not substitute for it.** A budget on an unauthenticated
endpoint buys time, not safety. C20 §5 puts an operator password, a session cookie, CSRF, and a
bind gate ahead of any non-loopback listen address; until that ships, local-first on `127.0.0.1`
remains the only supported deployment.

### OAuth callback security

`GET /api/drive/oauth/callback` is single-use. Connecting Drive mints a `state` and stores it
in `oauth_pending_states` with the PKCE verifier, an expiry, and — when operator authentication
is on — the session that started the connect. The callback consumes the row by **deleting** it
before it exchanges anything. A consumed state is therefore absent rather than marked, so
replaying a callback that already succeeded is refused. Two devices can hold independent pending
rows; a state cannot complete from a session other than the one that minted it. A state is also
refused once it is more than ten minutes old.

The exchange uses PKCE (`S256`). The verifier is minted beside the state, never leaves the
server, and is sent with the authorization code, so a code on its own cannot be redeemed.
Stored refresh and access tokens never reach the browser; Google Picker uses a separate
short-lived GIS token for folder selection only.

Every refusal answers with the same bare `400` and names nothing about why; the reason goes to
the server log. Refusing does not disturb other connects in flight — a callback whose state does
not match leaves every other pending row alone.

Request logs carry no credentials. The authorization code arrives in a query string, so requests
are logged by path only, with the query dropped rather than redacted, and the `Authorization` and
`Cookie` headers are redacted. What the log does hold about an integration failure is scrubbed
separately — see [Integration activity](#integration-activity).

### Production Content Security Policy

Production responses include a Content Security Policy. Scripts, API connections, images, media,
manifests, and workers are restricted to the application's own origin by default; objects are
disabled. Inline script is forbidden. The Google Fonts stylesheet (`fonts.googleapis.com`) and
font files (`fonts.gstatic.com`) remain allowed. Google Identity Services and Picker (C52) add
`apis.google.com` / `accounts.google.com` to scripts and connects, and
`docs.google.com` / `drive.google.com` / `accounts.google.com` to frames, so Settings can open
folder selection without widening arbitrary script hosts. Inline style attributes remain allowed
because React renders the task-progress width, the drag-and-drop transform, and the sidebar
palette as element styles. Automatic HTTP-to-HTTPS upgrading is disabled because the packaged
app is served on loopback HTTP by default.

Images and media are the two directives that accept a remote origin
(`img-src 'self' data: https:` and `media-src 'self' https:`), because both are referenced by
address and neither host can be known in advance: a sidebar logo, and the media a Signal post
carries, which the publishing preview renders in the browser. See
[Sidebar branding](#sidebar-branding) and
[Publishing Integration](docs/publishing-integration.md) §3.3. Responses also carry
`Referrer-Policy: no-referrer`, so a media host is never told which page asked for it.

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

### Merging clients

Duplicate client records split one relationship's work across two portfolios. **Merge client**,
on a client's own detail page, consolidates them: every project of the source client moves to a
destination client you choose, in one transaction, and the source is archived and recorded as
merged into it.

Clients are archive-only here as everywhere else — a merge deletes nothing. `client_merges` holds
one row per merged client (`source_client_id` → `surviving_client_id`, with the moment it
happened), which is also what makes the old name resolve to the surviving client on a later
import.

- **Previewed, then confirmed.** `POST /api/clients/:id/merge/preview` writes nothing and returns
  both clients, every project that would move, what each choosable field would end up as, and a
  `planHash`. `POST /api/clients/:id/merge` re-plans inside its own transaction and refuses a hash
  that no longer matches with a `409`, so a project added, renamed, or reassigned in the meantime
  forces a second look. The rules are database-free in `server/domain/client-merge.ts`; the writes
  are in `server/client-merge.ts`.
- **The work is moved, not rewritten.** Only `projects.client_id` changes. Project ids, tasks,
  checklists, dependencies, categories, ordering, dates, `updated_at`, `last_activity_at`, and
  every Drive reference are left exactly as they were. Every project moves whatever its status,
  archived and complete included. Identically named projects stay separate.
- **Fields are chosen, never combined.** Each of `name`, `contact_name`, `email`, `phone`,
  `website`, and `notes` is settled one at a time as **Keep destination** (the default),
  **Use source**, or a **Custom value** typed in the dialog, validated by the same schema a client
  edit is. Nothing else is choosable: `status` and every `drive_*` column are outside the request
  by shape, and the source keeps everything it had — a choice copies a value, it does not move one.
- **A blank value is a value.** The default is the client being kept whether or not it has anything
  in the field, so a merge nobody touches leaves the survivor reading exactly as it did. Filling a
  gap from the other record is a decision the person merging makes, not one the merge infers.
- **The slug follows the surviving name.** `clients.slug` is derived, not chosen: keeping the
  destination's name keeps its slug untouched, and any other surviving name rebuilds it from that
  name and the destination's own id — the same rule `PATCH /api/clients/:id` applies to a rename.
  Nothing is addressed by slug, so no link changes.
- **The hash covers the choices.** Both records' current values and every selected value are part
  of the plan, so a confirmation sent with different choices than the preview was taken under, or
  taken over a contact detail someone edited in the meantime, is refused with a `409` rather than
  writing a value nobody was shown.
- **The source may be active or archived**, as long as it has not already been merged elsewhere —
  a duplicate is usually archived already. The destination must be a live, unmerged client.
- **A merge cannot leak back.** `POST /api/clients/:id/unarchive` answers `409 CLIENT_MERGED` for
  a merged client, and `PATCH /api/projects/:id` refuses a `clientId` that is merged away
  (`409 CLIENT_MERGED`) or not `ACTIVE` (`400`), so no single edit can undo it.
- **Aliases follow the survivor.** Merging a client that is itself a survivor retargets the
  earlier rows in the same transaction, so A→B then B→C leaves A pointing at C and every lookup
  is one hop.
- **The Drive hierarchy is unchanged.** No `DriveProvider` method is called and no folder is
  moved, renamed, created, or deleted. Files still opens each project at the folder it always
  had, and the source client's own folder is left where it is. A later **Sync to Folder** does
  not move a connected folder; it will create a *missing* project folder under the destination
  client's folder, because provisioning parents new folders on the project's current client.
- **No `integration_events` row.** A merge is local workspace surgery, like archiving a project —
  the activity log is for what an *integration* did.
- **There is no undo.** Recover from a database backup. The migration is additive: an existing
  database gains one empty table.

### Campaign playbook import

`/import` imports a campaign playbook — an .xlsx workbook, or the same tabs pasted as
tab-separated text — into clients, projects, tasks, checklist items, and dependencies. The format
is specified in [`docs/campaign-playbook-import-format.md`](docs/campaign-playbook-import-format.md),
with a sample workbook in `docs/examples/`.

- **The sample is downloadable.** `GET /api/import/playbook/sample` serves
  `docs/examples/campaign-playbook-import-format.xlsx` with its `.xlsx` type and filename, and
  **Download sample playbook** on the Import page is that route. One fixed file, read from `docs/`
  rather than copied into the client build, so it cannot drift from the format document beside it.
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
- **A merged client's name is an alias.** A client of that name that was never merged still wins;
  otherwise the name resolves to the client it was merged into — one hop, because merging a
  survivor retargets the earlier aliases — and the skip names that rule rather than the ordinary
  one. New work is never created beneath a client whose portfolio was moved elsewhere.
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

### Signal Campaign and the calendar

Signal Campaign is authoritative for what is scheduled: `signal_posts` is the only store of
planned content, and nothing else in the app keeps a second copy of a schedule. `/calendar` reads
it and never writes.

- **A post carries a date and a time, never an instant.** `date` is a `YYYY-MM-DD` value read in
  local time and `time` is an `HH:MM` label beside it. **A post belongs to the calendar cell whose
  local date equals its date string** — that is the whole rule, and because no moment is ever
  derived from the pair, a post scheduled for the 14th is on the 14th in every zone and nothing
  shifts a day when the clocks change. A post with no date is in the unscheduled queue and
  deliberately appears on no calendar at all; inventing a cell for it would make an idea look
  scheduled.
- **Everything reads through `SignalProvider`.** It has one method and it lists. There is no
  counterpart that creates, moves, or reschedules, so the calendar cannot reach a write through
  the interface it consumes. Signal's own writes live in `server/signal/service.ts`, behind
  `/api/signal/*`, and nothing else calls them.
- **The two kinds stay two kinds.** `GET /api/calendar?from=&to=` returns scheduled posts and
  task due dates as two arrays, and the page renders them as two headed groups with their own
  icons and wording — never one list of "events" with a type tag. The moment they share a list
  something sorts and counts them together and the difference survives only as a colour. The
  distinction holds with the stylesheet off.
- **An agenda, not a grid.** Days are listed and empty days are dropped: a month cell cannot hold
  a post that runs to a thousand characters, and an agenda answers "what is happening and when"
  without three empty weeks in the way.
- **A failing schedule degrades the page rather than emptying it.** Task due dates still render,
  and the reason the other half is missing is shown. An unreadable schedule and a genuinely empty
  month are different claims and only one of them is ever true.
- **Archived work is out, completed work is in.** A calendar claims to show what is happening, and
  work under an archived client or project is not; finished tasks stay, with their status, because
  a calendar that dropped them would make a busy week look empty in hindsight.
- **Signal's own writes record no `integration_events`.** Editing a post is local data, like
  editing a task. The log is for what an *integration* did.
- **Queue health is derived, never stored.** A failed delivery, a slot about to pass unfilled, a
  manual finish waiting on somebody, a provider answer that moved, a channel with nothing planned,
  a synchronisation that is behind, and a post at the provider that this app did not send are all
  conclusions about rows that already exist —
  `shared/queue-health.ts` reaches them from posts, publications, one record of the last
  provider synchronisation, and the stored provider inventory, and the summary is recomputed on
  every read so it cannot go stale.
  Acknowledging one writes a single row to `signal_alert_acks` and touches nothing it reports; the
  row carries the fingerprint of the facts that were seen, so a situation that changes comes back as
  a live alert. No email, SMS, or push service is involved — the summary lives in the app.
- **Figures are read, never computed, and never written back.** The four numbers are the
  provider’s own; a per-day gain is a subtraction between two of its stored snapshots and nothing
  else. `server/publish/analytics.ts` holds an `AnalyticsProvider` with no way to publish,
  reschedule, or withdraw anything, it never touches `SignalProvider`, and it writes no post,
  publication, or delivery row — so a figure can never rewrite a plan or a delivery answer. A
  channel outside TikTok, YouTube, and Instagram has no figure at all rather than a figure of zero,
  and a failed refresh keeps the last values instead of replacing them.
  What the provider says about *which content* a record matched is stored beside the counts as
  provenance and never as a hedge on them: nullable, never defaulted, and a value this build has no
  words for is shown as the provider’s own token rather than borrowing a label from one it does.
- **The provider inventory is one snapshot generation, replaced whole or not at all.** A refresh
  reads every page of `GET /v1/posts` before the first row is written — `providerInventoryNextPage`
  is the verified pagination contract, shared with the probe that verified it, and a repeated offset,
  an unreadable page, or a safety bound stops the walk. A complete read then replaces
  `signal_provider_posts` in one transaction: ids the provider no longer lists are deleted, the rest
  are upserted, every row carries the same `snapshot_at`, and one `SUCCESS` event is written. A read
  that could not be finished replaces nothing, leaves the whole prior generation in place, and writes
  one `FAILURE` event — so there is no mixed-generation inventory and no row that alerts for ever
  merely because it disappeared. `ProviderInventoryProvider` can only list, and nothing on that path
  can adopt, edit, reschedule, or withdraw one of the provider's posts. It refreshes only when a
  person presses something; the alert is derived from the stored rows, so `deriveQueueHealth` still
  makes no network call.
- **Campaigns are a normalized join, and the free-text column they replaced is frozen.** A campaign
  is a row in `signal_campaigns` attached through `signal_post_campaigns`, exactly as tags label
  tasks and categories label projects — so a post can belong to several (the campaign *and* the week
  inside it), two spellings of one name are one campaign through the shared rule in
  `shared/types.ts`, renaming is one `UPDATE` that every post reads, and deleting cascades the join
  rows and touches no post. `signal_posts.campaign`, the single nullable free-text column that came
  before, is read exactly once — `backfillSignalCampaigns` runs on every boot, converts any post that
  still has a string and no campaign row, and resolves duplicate spellings to the one the earliest
  post used. It is kept rather than dropped because `server/db.ts` is additive by design and dropping
  a column is a full table rebuild; nothing reads it for behaviour and nothing writes it, so it is a
  record of what was there and not a second place a campaign lives. `npm run signal:import` writes
  the join too, and stays idempotent: it resolves the file's campaign name for the posts it inserts
  and touches no post it did not.
- **Figures segmented by campaign add, and say what they added.** A campaign total is the provider's
  own per-delivery figures summed over a named set of deliveries, and a trend point is the sum of
  per-day gains already subtracted from stored snapshots — no rate, ratio, or average anywhere.
  Every group reports how many of its deliveries are measured beside its total, and a group with
  nothing measured carries no total at all rather than a row of zeros. `GET
  /api/signal/analytics/campaigns` contacts no provider on any path, so opening the panel or moving a
  filter cannot spend a synchronisation; the numbers are the ones a post's own **Refresh figures**
  stored. Its date range asks *which posts*, not *which days* — a post scheduled inside it brings its
  whole measured history, and an undated post is in no range.
- **Media stays a reference, and a reference is one of two things.** A post carries an ordered list
  in `signal_post_media`, and each entry is either a public `https:` URL or a **Drive file**.
  Nothing fetches, downloads, proxies, or uploads the referenced files, and this app stores no media
  files and holds no media bytes at rest. A URL's kind is inferred from its extension and remains
  `unknown` when an extension does not say.
- **A Drive reference is bound to a version, not just to a file.** You add one by pasting a Drive
  share link; the server parses it, checks the host, and asks Drive what the file is, storing the
  name, MIME type, size, and Drive's own version evidence — its `version`, `modifiedTime`, and
  checksum. That is because a file id is not evidence of the bytes you previewed: Drive may replace
  a file's content under the same id. The kind of a Drive reference comes from the stored MIME type
  rather than from a share link that has no extension, and the publish plan hash covers the whole
  descriptor, so a file that moves invalidates a preview taken before it did. **Recheck Drive file**
  in the composer is the only thing that replaces a stored fingerprint; a recheck that fails leaves
  the reference and its last known details exactly where they are and says why. The one exception to
  the byte rule remains decided and **not built**: C75 in `docs/post-bridge-integrations-plan.md` is
  the confirmed submit's single stream from the selected Drive file to the provider, storing
  nothing. Files, the read-only Drive browser below, is unaffected — it is a separate capability
  with a separate interface, and it still browses a project's own folders and nothing else.
- **A cover image and a thumbnail are references too, and neither is delivered yet.** A platform
  layer — and an account layer — can carry one of each in `signal_post_variant_media`, under exactly
  the contract a post's own media has: a public `https:` URL or a version-bound Drive file, with its
  own **Recheck** and its own place in the plan hash, so a role edited or a role file replaced makes
  an open confirmation stale. What no role does is reach the provider. Post Bridge's document names
  an Instagram cover and a YouTube thumbnail, the live probe established neither, and its current
  support material says custom external YouTube thumbnails are unavailable — so a role can be chosen
  exactly where the provider names the field, is stored and version-checked, and says everywhere it
  appears that it is held rather than sent. The one media role that *is* verified needs no role row:
  a LinkedIn PDF publishes as a document post with the title the editor already collects.
- **One post can read differently per channel.** A post's content is the base; a platform override
  sits over it and an account override over that, resolved in that order by
  `shared/publish-variants.ts`. A layer says only what it changes, and clearing a field restores the
  post's own. A field is offered only where the provider capability contract carries it — X takes a
  first comment, YouTube takes a title — and the API refuses one it does not, from the same function
  the form renders from. What the provider cannot
  express refuses rather than guesses: it sends one media array per submission, so channels given
  different media are refused by name, and one set of content per platform, so an account override
  arrives as its platform's while that platform resolves to a single account.

`npm run signal:import` loads the campaign content Signal already held into `signal_posts`. It is
real content rather than demo data, which is why it is not part of `db:seed`; it is idempotent by
post id and never overwrites a post that is already there.

A post's planning status — `DRAFT`, `SCHEDULED`, `PUBLISHED` — describes its own progress and
nothing about the publishing integration: `PUBLISHED` is the user saying the post went out, while
provider delivery has its own publication state. Lifecycle (`ACTIVE` / `RETIRED`) and delivery
provenance (`IN_SIGNAL` / `OUTSIDE_SIGNAL`) are separate columns so Deleted and Outside of Signal
never overload that select — see [`docs/published-deletion-decision.md`](docs/published-deletion-decision.md).
That meaning is settled rather than provisional, and
[`docs/publishing-integration.md`](docs/publishing-integration.md) is where planning vs delivery was
settled.

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

CI runs the unit and integration suite as `npm run test:coverage` — the same tests with `--coverage` — and fails when any of the four source groups drops below the thresholds in `vitest.config.ts`. Run it locally before opening a pull request that removes or rewrites tests. The thresholds are what the suite measured when they were set, and the excluded paths are listed there with the reason each one is excluded; `coverage/` is generated and not committed.

Follow the [testing procedure](docs/testing.md) for behavior-based test selection, failure and
security assertions, focused regression proof, coverage review, and per-iteration evidence. Test
counts are inventory, not a target. A passing test must check an expected outcome; neither a high
coverage percentage nor a mocked success establishes production correctness. The PR template
records protected behavior and verification limits rather than requiring more tests each iteration.

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

Keep `GOOGLE_TOKEN_ENCRYPTION_KEY` with the backup; encrypted Drive tokens in SQLite cannot be read without it. Folder IDs and URLs survive restore on their own. Google Drive files require no local backup from this app; use Google's export/retention tools according to your own policy.

If `.env` sets `DATABASE_PATH`, pass the same path with `--database`. Write backups elsewhere with `--dir`.

### Retention

Every file in `data/backups/` is a full copy of the database, so the directory outgrows the data it protects unless something prunes it. `db:backup` keeps the newest **7** snapshots and deletes the rest:

```bash
npm run db:backup -- --keep 3
```

- Pruning runs only after the new snapshot is written. A backup that fails deletes nothing.
- Retention never removes the last remaining backup, whatever the count says.
- A snapshot's `-wal`, `-shm`, and `-journal` sidecars are deleted with it.
- `--keep 0` turns retention off and keeps everything.
- Only files named `command-center-<timestamp>.db` are considered. Anything else you put in that directory is left alone.

### Rehearsal

A backup you have never restored is a claim, not a backup, and the restore path is the one thing you cannot afford to discover is broken at the moment you need it. `db:backup:rehearse` restores a snapshot into a throwaway file, migrates it, and compares row counts, Drive folder references, and encrypted tokens against the source. It only reads the live database.

```bash
npm run db:backup:rehearse
```

**It runs on two triggers, and both are deliberate:**

1. **A scheduled task on the machine that owns the data**, weekly. This is the only place a rehearsal means anything: the database is local and gitignored, so a `workflow_dispatch` job in CI would rehearse a restore of an empty database that migrations had just created, pass, and report a green check that says nothing about your data — worse than no gate at all.
2. **Before merging a schema card**, by hand, on the machine holding the real data. A migration is the thing most likely to break a restore, and a weekly schedule can easily not have run since the last one.

Register the weekly task on Windows (adjust the path, and run it as the account that owns `data/`):

```bash
schtasks /create /tn "Command Center rehearsal" /sc weekly /d SUN /st 03:00 /tr "cmd /c cd /d C:\path\to\hybrid-command-center && npm run db:backup:rehearse -- --log data\backups\rehearsal.log"
```

A scheduled run reports failure in three places, because a background job that fails silently is the failure mode this exists to avoid:

- It **exits non-zero**, so Task Scheduler's *Last Run Result* shows the failure.
- It appends the full report to the `--log` file, which is never truncated — the run before the one that broke is the useful one.
- It leaves `data/backups/REHEARSAL-FAILED.txt`, and **every backup command prints a warning while that file exists**. A passing rehearsal removes it. This is what puts an unattended failure in front of a person: the next time you run `db:backup`, you cannot miss it.

A rehearsal that cannot run at all — missing database, unreadable backup directory — counts as a failure and is recorded the same way. The rehearsal also applies the same retention to what it writes, and leaves one `rehearsal-…db` copy behind for inspection; otherwise a weekly run would add a full database copy to the directory every week.

Schedule `db:backup` the same way if you want unattended snapshots — same command, same account, `--keep` doing the pruning.

## Troubleshooting

- **Drive says credentials required:** complete all four Google values in `.env` and restart.
- **Redirect URI mismatch:** make the Cloud Console URI and `GOOGLE_REDIRECT_URI` byte-for-byte identical.
- **Drive access revoked:** disconnect and reconnect from Settings, then use the retry action on failed records.
- **Root folder rejected:** paste a folder URL containing `/folders/…` or the folder ID itself, and confirm the connected account has access.
- **A project shows Drive issue:** the local record remains valid. Retry provisioning; completed steps are reused.
- **Database cannot open:** confirm the process can write to `data/`, or set an absolute `DATABASE_PATH`.
- **Port already in use:** change `PORT`, and update the Vite proxy if using a non-default API port.
- **Server exits with "Invalid environment configuration":** each line names a variable in `.env` and what was wrong with it. Fix them all and start again; the check reports every problem at once.
- **A request fails with "Something went wrong on the server":** the response carries an `errorId`. Search the server log for it — the actual error is logged there.

## Current MVP limitations

- Single local user; no collaboration, portals, permissions, billing, or time tracking
- No automatic Drive-folder rename after local name edits
- Clients can only be archived; there is no client delete. Merging one client into another archives the source rather than removing it, and cannot be undone or unmerged in the app. Projects and tasks delete permanently from SQLite with no in-app undo — recover from a database backup
- A merge moves one client at a time. It settles each contact field from one record or the other rather than combining the two, never combines same-named projects, and moves no Drive folder, so a merged client's folder stays beside the survivor's in Drive
- **Sync to Folder** provisions folder skeletons only; there is no file-level Drive sync, and nothing is uploaded, downloaded, or mirrored
- Google shared-drive-specific controls are not exposed
- The file browser is read-only by decision, not by omission: it lists and opens, and there is no upload, download, move, rename, or delete in the UI or in the API surface behind it. A project is browsable only at its own Drive folder and the subfolders provisioning recorded for it; anything deeper opens in Drive
- The calendar reads and never writes: it shows one month of scheduled content and task due dates and has no control that creates, moves, or reschedules anything. Editing a post belongs to the separate Signal planner
- Playbook import is create-only: it never edits or merges into a record that already exists, and there is no in-app undo of an import beyond deleting what it created
- Integration activity is bounded rather than permanent: the newest 200 records are kept and each lists at most 100 affected records, so it is a diagnostic log, not a compliance archive. Keep a database backup if a longer history matters
- Checklist reordering is supported by the API/data model; the current UI focuses on add, edit-by-state, and removal
- Publishing is deliberate and optional: a person presses **Show preview**, reads one tab per target account — the text that account receives, its media in order, its options, the local wall clock beside the provider instant, its delivery mode and its warnings — then confirms. Nothing remote loads before that press; public image and video previews are a further optional choice that warns about sharing the viewer's IP with the media host; a video needs its own press and never autoplays; and the server fetches no preview URL at all. The publisher records delivery separately and never sets `PUBLISHED`; after confirmed delivery, the user may mark the post published
- A non-loopback `HOST` fails the boot unless operator authentication is fully configured
  (`SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, https `APP_ORIGIN`, `PRODUCTION_TLS_TERMINATED=true`,
  explicit `TRUSTED_PROXY_HOPS`). When that checklist is complete, auth is required even with
  `HOST=127.0.0.1` behind Caddy (C114). Incomplete local checklist stays passwordless. Set the
  password with `npm run auth:bootstrap`. The AWS runtime contract is in
  [`docs/cloud-hosting.md`](docs/cloud-hosting.md) §11 (`TRUSTED_PROXY_HOPS=1` behind Caddy);
  account prerequisites are named in §12. C53's runtime files are in
  [`deploy/aws`](deploy/aws/README.md) and its secret-free payload is built with
  `npm run build:production-artifact`; C54 ships hosted backup timers and the off-site runbook;
  C55's [`cutover runbook`](docs/cloud-cutover-rehearsal.md) and `npm run cutover:rehearse` prove
  migration and rollback on disposable staging; **C115** is the operator-owned production column
  of that same runbook (public origin, secrets, data, DNS).
## Planned extension points

**Calendar:** `/calendar` has shipped read-only — `readCalendarRange` in `server/calendar.ts` over `SignalProvider` and the deadline domain functions, behind `GET /api/calendar`. Week and month-grid views would be further clients of that same range, not new reads. Editing stays in the Signal planner beside `server/signal/service.ts`; the calendar remains a window onto the schedule. Optional Google Calendar sync belongs in a separate provider beside Drive, not in task components. Every sync attempt should record to `integration_events` through `recordIntegrationEvent` — a sync that reads some sources and fails on one is the `PARTIAL` case the log was shaped for.

**Files:** `/files` has shipped read-only — `DriveProvider.listFiles` plus `server/drive/browse.ts` and the `GET /api/projects/:id/files` boundary. Extending it means adding upload/download/move/rename/search methods to the provider and a write path beside `browse.ts`, which stays read-only; a mutation belongs in its own module with its own confirmation flow. Continue storing only Drive IDs and metadata locally. UI components should never import `googleapis`.

Buffer TikTok and YouTube targets use a separate capability table and write adapter. A confirmed Buffer plan pins `customScheduled`, `needsApproval: false`, and the exact UTC instant, then creates one post per explicitly selected channel and stores each opaque remote id immediately. Partial and ambiguous results stay per target; an ambiguous create is never retried. Reconcile, edit, reschedule, and cancel read the exact target again and require a fresh comparison token plus Buffer's `allowedActions`. Notification scheduling sends text only and reminds you to attach media in the platform app; automatic TikTok may carry a direct public HTTPS URL in preview (`bufferWire`) where verified. Drive files and mixed Post Bridge plus Buffer targets refuse before confirmation. Production Buffer writes remain evidence-gated until the owner-run C83 round trip is recorded; automated coverage uses only mocks. **Publishing:** the Post Bridge implementation follows [`docs/publishing-integration.md`](docs/publishing-integration.md). It previews and confirms one scheduled Signal post, preflights its channels and ordered media, records delivery per publication, and blocks ambiguous retries. A post the provider already holds can then be updated, rescheduled, withdrawn, or resubmitted — each from a no-write comparison the user confirms, never as a side effect of a Signal edit, and never against a post the provider has already published (§7.2). `blog` remains outside every provider. Figures are read back against the provider’s own result identity per delivery, captured by reconciliation, through a service beside the publisher rather than inside it (§16). What the provider is holding is read the same way — a third interface that can only list, one snapshot generation replaced whole or not at all, and nothing that can act on a post this app did not send ([`docs/post-bridge-api-surface.md`](docs/post-bridge-api-surface.md) §6).

**Cloud hosting:** AWS contract settled (C50 / #176); authentication shipped (C51).
[`docs/cloud-hosting.md`](docs/cloud-hosting.md) §§1–8 keep the product shape. **§11** is the
production contract — EC2 + Caddy on loopback `HOST`, `TRUSTED_PROXY_HOPS=1`, EBS path
`/var/lib/hybrid-command-center/command-center.db`, SSM names under `/hcc/production/`, S3
off-site backups, `/api/health`, $20/month budget ceiling, RPO ≤24h / RTO ≤4h. **§12** names the
inert account resources (IAM role, sentinel SSM parameters, backup bucket, SNS, budget). C51 ships
the §5.1 password session, CSRF, and the bind gate that opens
only when that checklist is complete — bootstrap with `npm run auth:bootstrap` and put the printed
hash in `OPERATOR_PASSWORD_HASH` for any non-loopback bind. C53 packages the supported EC2 runtime
under [`deploy/aws`](deploy/aws/README.md): same-origin Caddy proxying, pre-traffic migration,
single-writer locking, retained EBS storage, and fail-closed production preflight. The manifest is
inert until an owner deploys it and contains no production credentials, DNS changes, or data.
C54 ships scheduled off-site backups and recovery monitoring ([`docs/offsite-backup-operations.md`](docs/offsite-backup-operations.md)).
C55 adds the [`cutover runbook`](docs/cloud-cutover-rehearsal.md) and `npm run cutover:rehearse`
for disposable staging proof. C114 enforces operator auth on the production checklist with
loopback `HOST`. **C115** is the production cutover column of that runbook — DNS, credentials,
and data stay operator-owned; after it succeeds, this README names the supported public origin.
C52 (`drive.file` + Picker) is this track.
Recommended order for Files extensions: (1) recent-files and cross-project search over the existing listing, (2) uploads/downloads, (3) guarded move/rename operations, (4) optional Calendar sync. Cloud implementation order is C51 → C52 → C53, with C54 parallel after C50; cutover is C55 → C114 → C115.

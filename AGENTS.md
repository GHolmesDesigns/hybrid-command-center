# Repository Guidance

## Structure

- `client/`: React UI only; it never imports Google SDKs or reads secrets.
- `server/domain/`: reusable, framework-free business rules.
- `server/drive/`: all Drive and OAuth behavior behind `DriveProvider`. `browse.ts` is the
  read-only half and must stay that way; writes live in `service.ts`.
- `server/signal/`: Signal Campaign's schedule, split the same way Drive is. `provider.ts` is the
  `SignalProvider` interface and `read.ts` is its implementation — the read-only half everything
  outside Signal consumes; writes live in `service.ts`. `campaign-archive.json` is the content
  Signal held before it was re-hosted here, and `archive.ts` imports it idempotently.
- `server/calendar.ts`: the read-only calendar — Signal's schedule and task due dates over one
  range, composed rather than joined, and degrading to tasks alone when the schedule cannot be read.
- `server/import.ts`: campaign playbook import — workspace snapshot, transactional commit, receipts.
- `server/integration-log.ts`: the append-only integration activity records every integration writes.
- `server/app.ts`: validated HTTP boundary; keep data writes transaction-safe.
- `server/db.ts`: local SQLite schema and indexes.
- `shared/`: stable cross-layer types and workflow constants.
- `e2e/`: browser-critical workflows.

## Development commands

- `npm run dev`: run UI and API
- `npm run db:migrate`: initialize/upgrade SQLite
- `npm run db:seed`: safe local demo data; never contacts Drive
- `npm run signal:import`: loads the campaign content Signal already held into `signal_posts`.
  Real content rather than demo data, which is why it is not part of `db:seed`. Idempotent by
  post id, and it never overwrites a post that is already there, so running it twice is safe.
- `npm test`: unit/integration tests with mock Drive
- `npm run test:e2e`: Playwright workflows. Playwright starts and stops the API and Vite
  itself, on ports 8788 and 5174, against `data/e2e.db`, which is deleted at the start of
  every run. The command exits on its own, passing or failing; if it ever does not, something
  it spawned outlived the run and that is the bug.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`: required quality checks
- `npm run check:version-bump`: fails when the branch has not moved the version past
  `origin/main`. Run it before opening a pull request — it is the only thing that catches a
  second card landing on a version another card already shipped.

## Conventions

- TypeScript strict mode. Validate all external input with Zod.
- The server runs under `node --experimental-strip-types`, which erases annotations without rewriting code. **Constructor parameter properties do not work there** — declare the field and assign it in the constructor instead. Vite transpiles them, so unit tests, typecheck, and the build all pass while the real server refuses to boot; `@typescript-eslint/parameter-properties` is enforced over `server/` and `shared/` so `npm run lint` catches it rather than end-to-end.
- Keep timestamps as UTC ISO strings and due dates as `YYYY-MM-DD` values interpreted in local time.
- Keep deadline rules and dependency rules out of React components.
- Archive rather than permanently delete top-level **clients**. Projects and tasks may be hard-deleted from SQLite when the user confirms; never delete or modify Drive files as a side effect of those actions.
- Labels are normalized joins, never packed columns: tags label tasks, categories label projects, and both match names case-insensitively through one shared rule in `shared/types.ts`. Renaming a label is one write; deleting one detaches it and never deletes what it was attached to.
- Sidebar branding defaults live in `shared/branding.ts`; runtime overrides are stored in the `settings` table under key `branding`. Its colour rules (`brandingIssues`, `sidebarPalette`, `shared/contrast.ts`) are enforced by the API and the form from the same functions — never validate branding on one side only. A logo is an `https:` reference; this app stores no user files.
- An import previews before it writes, plans from the same code twice — once for the preview, once against the workspace as it stands at the commit — and writes the whole hierarchy in one transaction. It skips a record the workspace already has, reports the rule that matched, and never edits one. The format is specified in `docs/campaign-playbook-import-format.md`; changing what the importer does means changing that document in the same branch.
- Every integration operation that changes local data records one `integration_events` row through `recordIntegrationEvent`, in the same transaction as whatever else it persists about the operation. The log is append-only: that module holds the only `INSERT` and the only `DELETE` — retention, keeping the newest 200 rows — and nothing updates a row, so a new integration adds a source and an operation to `shared/integration-log.ts` rather than a column or a write path. Report `PARTIAL` whenever some of an operation landed and some did not, and name what landed; an all-or-nothing operation reports `SUCCESS` or `FAILURE`. Never write a credential to it: pass structured fields, not a dump of a request or a provider response, and let `redactSecrets` scrub the one free-text field an external failure reaches.
- The Files module reads and nothing else. It browses a project only at its own Drive folder and the subfolders `drive_steps` recorded for it, matched by ID; any other folder ID is refused rather than fetched. Adding upload, download, move, rename, or delete means a new module beside `browse.ts` with its own confirmation flow, not a method on the browsing path — and it changes what `/files` promises, so the README and the user manual change in the same branch.
- Signal Campaign is authoritative for what is scheduled: `signal_posts` is the only store of planned content, and nothing else keeps a second copy of a schedule. A post carries a `YYYY-MM-DD` date and an `HH:MM` time and never an instant — it belongs to the calendar cell whose local date equals its date string, and no code derives a moment from the pair, which is what keeps a post on its own day in every zone. A null date is the unscheduled queue and belongs to no cell. Channels are a normalized join like tags and categories. Anything reading the schedule goes through `SignalProvider`, which has no write method by construction; adding one means a new module beside `read.ts`, not a method on it. Signal's own writes record no `integration_events` — it is local data now, like projects and tasks, and the log is for what an *integration* did.
- The calendar reads and never writes. Scheduled content and task due dates are two kinds and stay two kinds: two arrays in `shared/calendar.ts`, two headed groups on the page, never one list of "events" with a type tag — the moment they share a list something sorts and counts them together and the difference survives only as a colour. Signal failing degrades the page to task due dates with a visible reason, because an empty calendar and an unreadable schedule are different claims and only one of them is true.
- Pair visual status colors with text or icons and preserve visible keyboard focus.
- Prefer small service/provider boundaries over generic abstractions.

## Branches and versioning

- Branch from `main`. One card per branch, named `<type>/<issue>-<slug>` — for example `chore/2-prettier-reformat`, `fix/6-same-column-reorder`, `feat/9-projects-sort-by`.
- Types are `feat` (new capability), `fix` (defect), `chore` (tooling, dependencies, formatting), and `docs` (documentation only).
- Keep the slug lowercase, hyphen-separated, and short enough to scan in a branch list. The issue number is the identifier; the slug is a reminder.
- **Do not name branches after version numbers.** The version a card ships as is decided at merge time from milestone close order — the first card closed in a milestone takes the minor bump, the rest take patches — so it is unknowable when the branch is created. Several milestones carry four or five open cards at once.
- Every merged card ships a version bump. Run `npm version <new-version> --no-git-tag-version` and set `APP_VERSION` in `shared/branding.ts` to the same value, so `package.json` and both `package-lock.json` values stay aligned. The full bump rule is stated on each issue.
- The number is only settled once the branch merges. Cards run concurrently, so the minor a card claimed on the day it was cut may be taken by whichever card closes first — rebase, re-read `origin/main`, and take the next number rather than assuming the one already written is still free. `npm run check:version-bump` is what tells you, and it is a blocking CI gate.
- Settle the branch name before opening a pull request. Renaming a head branch closes the open PR, and it cannot be reopened once the old ref is gone.

## Security and Drive rules

- Never commit `.env`, OAuth credentials, encryption keys, tokens, SQLite files, or logs.
- Tokens are encrypted server-side and never returned to the browser.
- Drive is authoritative for files; SQLite stores only references and provisioning metadata.
- Identify Drive folders by IDs and stable idempotency properties, not names alone.
- Persist successful partial steps and make retries safe. Never mark Drive connected before every required step succeeds.
- Do not rename a Drive folder after a local rename without an explicit confirmation flow.
- Automated tests must use a mock provider and must never call real Drive.

## Definition of done

A change is done when its user flow is complete, validation and error states are present, relevant unit/integration tests pass, TypeScript and lint pass, the production build succeeds, responsive behavior is preserved, and no secret or real-Drive side effect is introduced.

Every gate in `.github/workflows/quality-gates.yml` blocks the merge, end-to-end included.

**Every milestone adds at least one `e2e/` spec.** Not every card — a milestone. The suite is the only check that runs the real browser against the real server, and it earns that cost only if it keeps pace with the features. Cover the flow the milestone was about, in one spec, end to end; leave the branches and the error paths to unit tests. Specs share one server and one database and run one at a time, so scope any count assertion to rows the spec created, or read the number back from the API in the same run.

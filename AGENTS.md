# Repository Guidance

## Structure

- `client/`: React UI only; it never imports Google SDKs or reads secrets.
- `server/domain/`: reusable, framework-free business rules.
- `server/drive/`: all Drive and OAuth behavior behind `DriveProvider`.
- `server/app.ts`: validated HTTP boundary; keep data writes transaction-safe.
- `server/db.ts`: local SQLite schema and indexes.
- `shared/`: stable cross-layer types and workflow constants.
- `e2e/`: browser-critical workflows.

## Development commands

- `npm run dev`: run UI and API
- `npm run db:migrate`: initialize/upgrade SQLite
- `npm run db:seed`: safe local demo data; never contacts Drive
- `npm test`: unit/integration tests with mock Drive
- `npm run test:e2e`: Playwright workflow
- `npm run typecheck`, `npm run lint`, `npm run build`: required quality checks

## Conventions

- TypeScript strict mode. Validate all external input with Zod.
- Keep timestamps as UTC ISO strings and due dates as `YYYY-MM-DD` values interpreted in local time.
- Keep deadline rules and dependency rules out of React components.
- Archive rather than permanently delete top-level **clients**. Projects and tasks may be hard-deleted from SQLite when the user confirms; never delete or modify Drive files as a side effect of those actions.
- Sidebar branding defaults live in `shared/branding.ts`; runtime overrides are stored in the `settings` table under key `branding`.
- Pair visual status colors with text or icons and preserve visible keyboard focus.
- Prefer small service/provider boundaries over generic abstractions.

## Branches and versioning

- Branch from `main`. One card per branch, named `<type>/<issue>-<slug>` — for example `chore/2-prettier-reformat`, `fix/6-same-column-reorder`, `feat/9-projects-sort-by`.
- Types are `feat` (new capability), `fix` (defect), `chore` (tooling, dependencies, formatting), and `docs` (documentation only).
- Keep the slug lowercase, hyphen-separated, and short enough to scan in a branch list. The issue number is the identifier; the slug is a reminder.
- **Do not name branches after version numbers.** The version a card ships as is decided at merge time from milestone close order — the first card closed in a milestone takes the minor bump, the rest take patches — so it is unknowable when the branch is created. Several milestones carry four or five open cards at once.
- Every merged card ships a version bump. Run `npm version <new-version> --no-git-tag-version` and set `APP_VERSION` in `shared/branding.ts` to the same value, so `package.json` and both `package-lock.json` values stay aligned. The full bump rule is stated on each issue.
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

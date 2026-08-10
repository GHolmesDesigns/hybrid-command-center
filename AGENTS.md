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

# Repository Guidance

## Structure

- `client/`: React UI only; it never imports Google SDKs or reads secrets.
- `server/domain/`: reusable, framework-free business rules.
- `server/drive/`: all Drive and OAuth behavior behind `DriveProvider`. `browse.ts` is the
  read-only half and must stay that way; writes live in `service.ts`. `media.ts` is a third,
  narrower capability with a provider interface of its own — one user-supplied Drive link resolved
  to metadata and version evidence for a Signal media reference, reading no bytes. Files receives
  `DriveProvider` and cannot reach it.
- `server/signal/`: Signal Campaign's schedule, split the same way Drive is. `provider.ts` is the
  `SignalProvider` interface and `read.ts` is its implementation — the read-only half everything
  outside Signal consumes; writes live in `service.ts`. `campaigns.ts` is the campaign vocabulary —
  the shared list a post is labelled from, beside the schedule rather than inside it, the way
  `queue-health.ts` sits beside it. `campaign-archive.json` is the content Signal held before it was
  re-hosted here, and `archive.ts` imports it idempotently.
- `server/calendar.ts`: the read-only calendar — Signal's schedule and task due dates over one
  range, composed rather than joined, and degrading to tasks alone when the schedule cannot be read.
- `server/agent-coordination/`: agent handoff queue beside the workspace. Domain rules in
  `server/domain/agent-coordination.ts`; persistence in `service.ts`. Claim/complete never mutate
  tasks, Signal posts, or any provider path; audit is the handoff row and notes, not
  `integration_events`. MCP tools are C111; operator inbox UI is C112.
- `server/mcp/`: stdio and authenticated HTTP MCP (`stdio.ts`, `http.ts`). **Coordination shipped
  first (C111–C113):** handoff tools and `hcc://coordination/inbox` on both transports; workspace
  and Signal MCP tools remain MCP-C106–C108. Each coordination tool maps to one
  `agent-coordination` service method. `mcp_agent_events` is append-only (500-row retention).
  Coordination writes require a non-empty init `agent_label` and share a 10/minute session budget
  on stdio; network writes use the persisted limiter registry (C116).
- `server/import.ts`: campaign playbook import — workspace snapshot, transactional commit, receipts.
- `server/integration-log.ts`: the append-only integration activity records every integration writes.
- `server/change-feeds.ts`: durable, per-feed monotonic change logs for MCP resume
  (`hcc://coordination/changes`, `hcc://workspace/changes`). Append-only with bounded retention;
  an expired cursor returns an explicit reload-snapshot result rather than a silent gap.
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
- `npm run probe:post-bridge`: the Post Bridge contract probe, `scripts/probe-post-bridge.ts`. It
  plans by default and contacts nothing; `--live` writes scheduled posts to the provider accounts
  named on the command line and deletes them again in a `finally`, and it refuses to start without
  `POST_BRIDGE_API_KEY` in the environment, `--yes`, `--accounts-approved`, an instant at least 48
  hours out, an unused `--probe-label`, an explicit `--account <platform>:<id>` for every account,
  and the label typed back at the prompt. There is no default account and no first-matching
  behaviour. **Owner-run only, and never in CI**: it is a write against real social accounts. Its
  request budget is a hard 50 including cleanup. What it establishes goes in §14 of
  `docs/post-bridge-api-surface.md` as a dated result matrix — the transcript is never committed.
- `npm run probe:buffer`: the Buffer GraphQL contract probe, `scripts/probe-buffer.ts`. It plans by
  default and contacts nothing. Live mode is owner-run only and never CI: it requires
  `BUFFER_API_KEY` (or the one-release `BUFFER_KEY` fallback), `--live`, `--yes`,
  `--channels-approved`, exact account and organization ids, and every connected routed channel as
  `--channel tiktok:<id>` / `--channel youtube:<id>`. `--target <service>:<id>` may narrow the write
  subset but must name one of those approved connected channels. It also needs a zoned instant at
  least 48 hours away, an unused label, and the label typed back. An owner-approved public fixture is
  passed explicitly as
  `--media <service>:<image|video>:<https-url>`; the URL must be credential-free, query-free HTTPS
  and is bound only to that approved service. The same fixture is sent on create and edit; live
  TikTok evidence shows that omitting it from edit is refused rather than preserved. It creates one
  disposable scheduled post per approved target, reads and edits each, and deletes only those ids in
  `finally`; a complete paginated read must prove absence. Its
  hard 50-request budget reserves 12 calls for cleanup. The credential and transcript are never
  committed.
- `npm test`: unit/integration tests with mock Drive
- `npm run test:coverage`: the same suite with coverage and its thresholds. CI runs this rather
  than `npm test`, so a drop below any project's threshold fails the build. The thresholds are
  the measured figures, not targets — raise one when the suite genuinely covers more, and do not
  lower one to make a branch pass.
- `npm run test:e2e`: Playwright workflows. Playwright starts and stops the API and Vite
  itself, on ports 8788 and 5174, against `data/e2e.db`, which is deleted at the start of
  every run. The command exits on its own, passing or failing; if it ever does not, something
  it spawned outlived the run and that is the bug.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`: required quality checks
- `npm run check:version-bump`: finalization gate. Draft pull requests defer it; after review,
  refresh `origin/main`, assign the next version, and run it before marking the pull request
  ready. It catches a second card trying to land on a version another card already shipped.

## Conventions

- TypeScript strict mode. Validate all external input with Zod.
- The server runs under `node --experimental-strip-types`, which erases annotations without rewriting code. **Constructor parameter properties do not work there** — declare the field and assign it in the constructor instead. Vite transpiles them, so unit tests, typecheck, and the build all pass while the real server refuses to boot; `@typescript-eslint/parameter-properties` is enforced over `server/` and `shared/` so `npm run lint` catches it rather than end-to-end.
- Keep timestamps as UTC ISO strings and due dates as `YYYY-MM-DD` values interpreted in local time.
- Keep deadline rules and dependency rules out of React components.
- Default views and durable URL state follow `docs/view-state-convention.md`; transient text search may stay local.
- Archive rather than permanently delete top-level **clients**. Projects and tasks may be hard-deleted from SQLite when the user confirms; never delete or modify Drive files as a side effect of those actions.
- Merging one client into another moves its projects, archives the source and records it in `client_merges` as an alias of the survivor, retargets earlier aliases so every lookup stays one hop, never touches Drive, and never writes an `integration_events` row. What the survivor holds is chosen field by field over exactly the six a person edits — `name`, `contact_name`, `email`, `phone`, `website`, `notes` — each defaulting to the survivor's own value whether or not it is blank, because inferring from blankness would make the merge decide which record is current. `status` and every `drive_*` column are outside the choice, and `slug` is derived from the surviving name by `buildClientSlug`, the same rule a rename follows. The plan carries both records' values and every chosen one, so the confirmation hash covers them and a preview taken under other choices cannot be confirmed.
- Labels are normalized joins, never packed columns: tags label tasks, categories label projects, Signal campaigns label Signal posts, and all three match names case-insensitively through one shared rule in `shared/types.ts` (`normalizeSignalCampaignName` aliases it). Renaming a label is one write; deleting one detaches it and never deletes what it was attached to. Campaigns are Buffer's *tags* under Signal's own word, because tags here label tasks: a post carries as many as it needs — the campaign and the week inside it — and the free-text `signal_posts.campaign` column they replaced is frozen, read once by `backfillSignalCampaigns` and never again. It is kept rather than dropped because `server/db.ts` is additive by design and a drop is a table rebuild; it is not a second place a campaign lives.
- Sidebar branding defaults live in `shared/branding.ts`; runtime overrides are stored in the `settings` table under key `branding`. Its colour rules (`brandingIssues`, `sidebarPalette`, `shared/contrast.ts`) are enforced by the API and the form from the same functions — never validate branding on one side only. A logo is an `https:` reference; this app stores no user files.
- An import previews before it writes, plans from the same code twice — once for the preview, once against the workspace as it stands at the commit — and writes the whole hierarchy in one transaction. It skips a record the workspace already has, reports the rule that matched, and never edits one. The format is specified in `docs/campaign-playbook-import-format.md`; changing what the importer does means changing that document in the same branch.
- Every integration operation that changes local data records one `integration_events` row through `recordIntegrationEvent`, in the same transaction as whatever else it persists about the operation. The log is append-only: that module holds the only `INSERT` and the only `DELETE` — retention, keeping the newest 200 rows — and nothing updates a row, so a new integration adds a source and an operation to `shared/integration-log.ts` rather than a column or a write path. Report `PARTIAL` whenever some of an operation landed and some did not, and name what landed; an all-or-nothing operation reports `SUCCESS` or `FAILURE`. Never write a credential to it: pass structured fields, not a dump of a request or a provider response, and let `redactSecrets` scrub the one free-text field an external failure reaches.
- The Files module reads and nothing else. It browses a project only at its own Drive folder and the subfolders `drive_steps` recorded for it, matched by ID; any other folder ID is refused rather than fetched. Adding upload, download, move, rename, or delete means a new module beside `browse.ts` with its own confirmation flow, not a method on the browsing path — and it changes what `/files` promises, so the README and the user manual change in the same branch.
- **Signal publishing media is a separate boundary from Files, and narrower than the media comments
  used to state.** This app stores no media files, serves no media bytes, and holds no media bytes at
  rest. `server/drive/media.ts` is that boundary: it **resolves** one
  user-supplied Drive link — parsed as a URL and host-checked before anything is looked up — to
  canonical metadata and a version fingerprint without reading bytes. Its separate confirmed byte
  path streams that same file straight to the provider's upload URL
  during a confirmed submit, update, or restore-and-resubmit, persisting nothing and never writing to
  Drive. Neither
  half is available to Files, which keeps the rule above exactly as written: project-scoped browsing
  with no upload, download, move, rename, or delete, and no byte method on `browse.ts` or
  `shared/drive.ts`. The two capabilities are two interfaces on purpose — `DriveProvider` is the
  browsing vocabulary and `DriveMediaProvider` the metadata read — so widening one cannot widen the
  other by accident. A provider media ID is ephemeral: it is never a durable Signal reference and is
  recreated on every submit, update, and restore-and-resubmit. The vendor's 24-hour and on-publish
  deletion behavior is documented but unverified, so nothing may depend on the timing until C73
  records live evidence.
- **A Signal media reference is discriminated, and a Drive one is bound to a version.** A row in
  `signal_post_media` is a public `https:` URL or a Drive file, never something in between: the rule
  is one function, `signalPostMediaIssue` in `shared/signal-media.ts`, and it is enforced at the Zod
  boundary, in the write service, and by SQLite triggers, because a rule stated in one layer is one
  the next `INSERT` walks around. A Drive row carries Drive's name, MIME type, size, and at least one
  version signal, because a file ID is not evidence of the bytes anyone previewed — Drive may replace
  a file's content under the same ID. `url` stays non-null for both and is what display and the
  per-platform media selection read; a Drive row's `url` is Drive's viewer page and is never fetched
  or embedded. Classify a reference with `signalMediaKindFor`, never by passing a Drive row's URL to
  `signalMediaKind`. **A preview makes no Drive call**: preflight reads the stored MIME type, and the
  plan hash covers the whole descriptor and fingerprint so a file that moves invalidates a plan taken
  before it did. A stored fingerprint is replaced only by an explicit recheck, which goes through the
  ordinary Signal edit transaction; an ordinary save carries an existing reference forward untouched,
  and a failed recheck writes nothing and leaves the last metadata visible.
- **A variant media role is the same reference under the same rule, one table over.** A cover image
  and a thumbnail live in `signal_post_variant_media`, keyed `(post_id, platform, account_id, role)`,
  under `signalPostMediaIssue` and the same two SQLite triggers — built once in `server/db.ts` and
  spent on both tables, because a second table holding the same kind of thing under a weaker rule is
  where the rule stops being true. `signal_post_variants.cover_image_url` and `.thumbnail_url` are
  frozen: `backfillSignalVariantRoleMedia` moves each value into a `URL` role row and clears the
  column in the same transaction, so there is one writable source and a role a person removes is not
  resurrected on the next boot. **Storing a role and delivering one are separate questions** —
  `publishRoleComposable` and `publishRoleDelivers` in `shared/publish-variant-media.ts` — and a
  capability flag goes true only where `docs/post-bridge-api-surface.md` §14 records the provider
  accepting the field and reading it back. Nothing is uploaded for an undelivered role and no wire
  field is invented from OpenAPI; a stored role warns, by platform and by role, everywhere it appears.
- Signal Campaign is authoritative for what is scheduled: `signal_posts` is the only store of planned content, and nothing else keeps a second copy of a schedule. A post carries a `YYYY-MM-DD` date and an `HH:MM` time and never an instant — it belongs to the calendar cell whose local date equals its date string, and no code derives a moment from the pair, which is what keeps a post on its own day in every zone. A null date is the unscheduled queue and belongs to no cell. Channels and campaigns are normalized joins like tags and categories; a post with no campaign is **No campaign** wherever campaigns are grouped, never a hidden post. Anything reading the schedule goes through `SignalProvider`, which has no write method by construction; adding one means a new module beside `read.ts`, not a method on it. Signal's own writes record no `integration_events` — it is local data now, like projects and tasks, and the log is for what an *integration* did.
- The calendar reads and never writes. Scheduled content and task due dates are two kinds and stay two kinds: two arrays in `shared/calendar.ts`, two headed groups on the page, never one list of "events" with a type tag — the moment they share a list something sorts and counts them together and the difference survives only as a colour. Signal failing degrades the page to task due dates with a visible reason, because an empty calendar and an unreadable schedule are different claims and only one of them is true.
- Figures are read, never computed, and never written back. `server/publish/analytics.ts` holds an
  `AnalyticsProvider` (`analytics-provider.ts`) with `sync`, `list`, and `days` and no way to submit,
  update, or cancel anything, it does not import `SignalProvider`, and it writes only
  `signal_post_metrics`, `signal_post_metric_days`, its own connection record, and one
  `integration_events` row — never a post, a publication, or a target. The four numbers are the
  provider's own and a per-day gain is a subtraction between two of its stored snapshots
  (`shared/publish-analytics.ts`); anything derived beyond that belongs to a card that decides what
  it means. A channel outside the platforms the provider measures has **no** figure rather than a
  figure of zero, and a refresh that the provider refuses or that fails leaves the last known good
  values exactly where they were — every provider read completes before any write. `refresh` is
  reached only by a person pressing something: there is no timer on this path.
  What the provider says about *which content* a record matched — `match_confidence` and
  `platform_post_id` — is stored beside the four numbers as provenance and never as a hedge on them:
  nullable, never defaulted, shown under **Provider match** with a sentence saying it does not
  qualify the counts. A match value is kept only in the shape `[a-z0-9_-]{1,40}` and is never trimmed
  or lower-cased into one this build has words for; anything else is dropped and warned about on the
  log row. Giving a verified value a label of its own means one entry in
  `ANALYTICS_MATCH_CONFIDENCE_LABEL` and a dated §14 result, not a fallback at a call site.
- Segmenting figures by campaign adds exactly one derivation and says so:
  `shared/signal-campaign-analytics.ts` **adds** the provider's own per-delivery figures over a named
  set of deliveries, and sums per-day gains that `postMetricDayDeltas` has already subtracted. No
  rate, ratio, average, or per-post normalisation — those still belong to a card that decides what
  they mean. Every group reports `measuredDeliveries` beside `deliveries`, and a group with nothing
  measured carries **no** `totals` field rather than a row of zeros, which is
  `postMetricAvailability`'s distinction carried up to an aggregate. `server/publish/campaign-analytics.ts`
  only gathers rows: it holds no provider, makes no network call, and has no statement that writes, so
  opening a campaign view can never spend a synchronisation. Its date range asks *which posts*, not
  *which days* — a post scheduled inside it brings its whole measured history, and an undated post is
  in no range at all.
- **What the provider is holding is a snapshot, replaced whole or not at all.**
  `server/publish/inventory.ts` reads `GET /v1/posts` through a fourth provider interface —
  `ProviderInventoryProvider`, which can only list, beside `PublishProvider` and `AnalyticsProvider`
  for the same reason `browse.ts` sits beside `service.ts`. Every page is read before the first
  statement runs: a repeated offset, an unreadable page, an unverified next-page token, or a
  page/row safety bound fails the refresh, and a failed refresh replaces nothing and leaves the whole
  prior generation in place. A complete read replaces `signal_provider_posts` in one transaction —
  ids the provider no longer lists deleted, the rest upserted, one `snapshot_at` across the
  generation — so there is no mixed-generation inventory. The outcome is `SUCCESS` or `FAILURE` and
  never `PARTIAL`, because the write is one transaction after every read. `refresh` is reached only by
  a person pressing something, and the pagination rule itself is `shared/provider-inventory.ts`,
  shared with the probe that verified it — one rule, not two copies. Nothing on this path can adopt,
  import, edit, reschedule, or withdraw a provider post: those are declined in §0.3 of
  `docs/post-bridge-integrations-plan.md` and no method exists for them. A row stores a bounded
  caption excerpt and never a raw response.
- Queue health is derived, never stored. `shared/queue-health.ts` concludes every alert from rows that already exist — posts, publications, targets, the record of the last provider synchronisation, and the stored provider inventory — and `server/signal/queue-health.ts` only gathers them, so there is no alerts table to fall out of step with what it reports. Acknowledging writes one row to `signal_alert_acks` and nothing else: it must never touch a post, a publication, a target, or a planning status, and it writes no `integration_events` row. The acknowledgement carries the fingerprint of the facts it was shown, so a situation that moves on comes back as a live alert rather than staying dismissed. Adding an alert kind means a rule in the shared module and a fixture test beside it, never a check inside a component.
- Pair visual status colors with text or icons and preserve visible keyboard focus.
- Prefer small service/provider boundaries over generic abstractions.

## Branches and versioning

- Branch from `main`. One card per branch, named `<type>/<issue>-<slug>` — for example `chore/2-prettier-reformat`, `fix/6-same-column-reorder`, `feat/9-projects-sort-by`.
- Types are `feat` (new capability), `fix` (defect), `chore` (tooling, dependencies, formatting), and `docs` (documentation only).
- Keep the slug lowercase, hyphen-separated, and short enough to scan in a branch list. The issue number is the identifier; the slug is a reminder.
- **Do not name branches after version numbers.** The version a card ships as is decided at merge time from milestone close order — the first card closed in a milestone takes the minor bump, the rest take patches — so it is unknowable when the branch is created. Several milestones carry four or five open cards at once.
- Every merged card ships a version bump, but feature work must not claim one while it is under
  review. Keep the pull request **draft** and add one issue-specific fragment at
  `changes/<issue>.md` instead of editing `CHANGELOG.md`, `package.json`, `package-lock.json`, or
  `shared/branding.ts`. The fragment is user-facing Markdown with the eventual changelog section
  (`Added`, `Changed`, `Fixed`, or another Keep a Changelog heading), its bullets, and a
  `Breaking changes` heading whose content is explicit, including `None.`. One file per card means
  concurrent cards do not conflict.
- After review, the merge owner serializes finalization: refresh `origin/main`, merge or rebase it
  into the branch, reread the issue's bump rule, and take the next available version. Run
  `npm version <new-version> --no-git-tag-version`, set `APP_VERSION` in `shared/branding.ts` to the
  same value, move the fragment's content under a new dated version heading at the top of
  `CHANGELOG.md`, and delete the fragment. Run `npm run check:version-bump` and all required gates,
  then mark the pull request ready and merge it. If another card lands first, repeat finalization
  against the new `origin/main`; never preserve a now-taken number.
- A ready pull request must contain the finalized version and no fragment for its card. A draft
  pull request must contain the fragment and must leave the four shared release locations alone.
  Dependabot and other automated branches follow the same draft-then-finalize path.
- Settle the branch name before opening a pull request. Renaming a head branch closes the open PR, and it cannot be reopened once the old ref is gone.
- Changelog fragments and finalized entries say what changed for someone using the app, not which
  files moved. State breaking changes explicitly — including their absence, so a major digit is
  never left to be inferred.

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

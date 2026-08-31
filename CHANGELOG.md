# Changelog

All notable changes to Hybrid Command Center are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 3.0.0 were not recorded in this file; `git log` is authoritative for them.
The version a card ships as is decided at merge time — see the bump rule in `AGENTS.md`.

## [5.10.2] - 2026-08-31

### Fixed

- Codex hosted HTTPS setup now generates TOML for the config.toml file it names, retaining the bearer authorization prefix and agent label. Cursor and Claude Code keep their JSON configurations, and Claude Desktop keeps its connector fields.

### Breaking changes

None.

## [5.10.1] - 2026-08-31

### Fixed

- Rotating an MCP agent credential preserves its original lifetime independently of the issue form. Confirmation shows the exact new expiry, and the credential list displays expiry in UTC.

### Breaking changes

None.

## [5.10.0] - 2026-08-31

### Added

- MCP OAuth for Claude chat and Cowork: protected-resource and authorization-server discovery,
  dynamic client registration, browser sign-in and approval, and token exchange that issues the
  same scoped `hcc_mcp_` credentials as Agents → Agent connection setup. Unauthenticated MCP
  requests now return `WWW-Authenticate` with a resource metadata URL so name-and-URL-only
  connectors can authenticate without editing JSON or pasting a bearer into claude.ai settings.

### Changed

- Agents connection setup and the Claude chat/Cowork guide now describe the OAuth connector flow
  (server URL only, approve once in the browser) instead of a non-existent Authorization field.
- Approving a connector is now a form submission from the approval screen rather than a link. An
  approval that cannot prove it came from that screen is refused, so following a link can no longer
  connect a connector on your behalf without the screen ever being shown.
- A connector no longer gets to pick which agent it connects as. Its label is derived from the
  connector name *and* its registration — `claude-oauth-<name>-<client-id>` — so approving one can
  only ever replace that same connector's earlier credential. Previously a connector that named
  itself after one of your agents took that agent's name and revoked its credentials on approval.
  Nothing needs pre-registering any more, and agents you registered yourself are left alone.
- A connector that asks for a capability this server does not offer is now turned away, naming the
  capability. It used to be granted every capability instead.
- Signing out now takes effect immediately on a connection you approved but Claude has not finished
  setting up. The approval stayed redeemable for its full ten minutes after sign-out, which is the
  window you would be trying to close if you had just realised an approval was not yours.

### Breaking changes

None.

## [5.9.7] - 2026-08-30

### Added

- Added a connection and efficiency guide for Claude chat and Claude Cowork, covering connector
  setup on those surfaces, the store-identity check before coordination writes, and how to read the
  workspace efficiently.

### Changed

- Updated the Version 5b feasibility report: the guided MCP credential flow is recorded as shipped,
  with post-implementation findings and a full-repository review of the current code.

### Breaking changes

None.

## [5.9.6] - 2026-08-30

### Added

- Added **Claude Desktop / claude.ai** as a client option in Agents → Agent connection setup, with
  steps for adding a custom connector in claude.ai settings. Claude Desktop, claude.ai chat, and
  Cowork use account-level connectors rather than per-project configuration, and previously the only
  Claude option described Claude Code's setup instead.

### Fixed

- The copied HTTPS setup is now a complete configuration document rather than a fragment, so it is
  valid where the guide says to paste it.
- The Claude Desktop / claude.ai steps offer the server URL and credential as separate values,
  matching a connector form that asks for each field on its own, and no longer suggest pasting a
  configuration blob into a field expecting a URL.
- The connection steps for connector-based clients no longer instruct operators to send an
  `x-agent-label` header. The agent label travels inside the credential, and a header that disagrees
  with it is rejected.

### Breaking changes

None.

## [5.9.5] - 2026-08-30

### Added

- Added an **Agents** page in the sidebar for connection setup, connection health, and agent handoffs.
- Added a guided HTTPS credential flow with client-specific steps, one-click ready-to-paste setup, and in-app **Rotate** — no PowerShell or hand-edited config files required.

### Changed

- Moved Agent connection setup, Connection health, and Agent handoffs out of Settings onto the Agents page.

### Breaking changes

None.

## [5.9.4] - 2026-08-29

### Fixed

- `system_connection_status` now returns a `storeId` that stays stable across restarts and differs
  between independent SQLite files, so an agent (or the operator's Settings diagnostic) can tell a
  local stdio MCP connection apart from the hosted production HTTPS connection even when the agent
  label, tool list, and capability version all match. Previously the two could look identical while
  silently backed by two unsynced coordination stores, so a claim/complete made through one endpoint
  could report success while the other endpoint — and the operator's live inbox — still showed the
  handoff open.
- `docs/agent-coordination-plan.md` now states plainly that the hosted HTTPS origin is the sole
  authoritative store for the shared agent coordination inbox and that local stdio is
  workstation-local only.
- `docs/mcp-agent-workflow.md` and the Cursor/Claude skill wrappers now tell agents to compare
  `storeId` across connections and route coordination writes through HTTPS prod.
- Settings connection diagnostics (Agent connection setup and Connection health) now show the store
  id beside capability version so operators can tell two connections apart at a glance.

### Breaking changes

None.

## [5.9.3] - 2026-08-29

### Added

- Deterministic MCP agent evaluation suite on a non-production fixture database, covering claim
  workflows, idempotent retries, stale revisions, leased work sessions, approval boundaries,
  dual-agent identity, revocation, rate-limit persistence, and change-cursor recovery after
  restart — scored on success, evidence, latency, and approximate token use.
- Owner-run read-only production MCP smoke (`npm run eval:mcp-smoke`) that plans by default and,
  with `--live`, runs the operator connection diagnostic and asserts workspace checksums do not
  move.
- Dated evaluation matrix in `docs/mcp-agent-evaluation.md` (transcript never committed).

### Breaking changes

None.

## [5.9.2] - 2026-08-29

### Added

- Streamable HTTP MCP lifecycle on `/api/mcp`: session id on initialize, GET SSE listen,
  DELETE teardown, progress notifications, resource subscriptions, and cancellation that does
  not leave a partial write.
- A protocol conformance suite that runs the same cases over stdio and HTTP.

### Changed

- `initialize` advertises `resources.subscribe`. Resource-update tips are an optimization on top
  of C132 change-feed cursors — an agent that ignores every notification still converges by
  cursor.

### Breaking changes

None.

## [5.9.1] - 2026-08-29

### Fixed

- Re-issuing an MCP agent credential after revoke no longer fails when you reuse the same agent
  name. Settings kept the registration row for audit, which blocked the unique label; issue now
  reuses that registration when nothing active still holds the name, and refuses a clear conflict
  when one does.

### Breaking changes

None.

## [5.9.0] - 2026-08-29

### Added

- Cursor-based MCP change feeds at `hcc://coordination/changes` and `hcc://workspace/changes`, so an
  agent that disconnects can resume from an opaque cursor instead of re-reading the whole inbox.
  Cursors survive process restart, replay is gap-free within retention, and an expired cursor returns
  an explicit reload-snapshot result rather than a silent partial feed.

### Breaking changes

None.

## [5.8.2] - 2026-08-29

### Added

- MCP tools for campaign playbook and Signal import preview/commit, client merge preview/commit,
  Drive media resolve and recheck, project-scoped Files browse, integration activity listing, Drive
  sync, and provider inventory / analytics window / Buffer account refreshes.
- A separate rolling 6-per-minute budget for MCP integration writes, independent of the existing
  coordination write budget.

### Breaking changes

None.

## [5.8.1] - 2026-08-29

### Added

- Agents with `workspace:write` can create and update tasks (including checklist and
  dependencies), projects, Signal drafts (slot, variants, targets, duplicate), acknowledge
  queue alerts, and update branding and view defaults over MCP — each write carries an
  idempotency key, a revision where the entity has one, and a before/after summary.
- Destructive MCP deletes for tasks and projects refuse unless `confirm: true` and a matching
  typed id are supplied. Compound Signal variant and target writes support a dry-run preview.
- MCP Signal creates stay Class-L: Drive media resolve and provider publish remain unavailable.

### Breaking changes

None.

## [5.8.0] - 2026-08-29

### Added

- Added optimistic revision preconditions to workspace and Signal mutations so concurrent UI and agent edits are refused with the current revision and changed fields instead of silently overwriting newer work.

### Breaking changes

- Existing HTTP update clients must include the latest positive integer `revision` returned by the corresponding read. Missing revisions are refused.

## [5.7.3] - 2026-08-29

### Added

- Added leased agent work sessions with heartbeats, checkpoints, resumable context, explicit release, and operator reclaim of expired work.
- Added MCP work-session tools and persistence with one-live-lease protection.

### Breaking changes

None.

## [5.7.2] - 2026-08-28

### Added

- Canonical MCP agent workflow document at `docs/mcp-agent-workflow.md` — the single source for the
  claim → work → prove loop, approval boundaries, and when to stop for the operator.
- Thin skill wrappers for Cursor (`.cursor/skills`), Claude Code (`.claude/skills`), and Codex
  (`.codex-plugin/`) that point at the workflow document without restating policy.
- **Settings → Agent connection setup** guided flow: register an agent, issue a scoped credential
  once, generate copy-ready client configuration for Cursor, Claude Code, or Codex, run the
  read-only connection diagnostic, and see the agent's last successful connection.

### Breaking changes

None.

## [5.7.1] - 2026-08-28

### Added

- Added five MCP workflow prompts for claiming work, reviewing project status, preparing handoffs,
  verifying completion evidence, and triaging the Signal queue over both stdio and HTTP.

### Breaking changes

None.

## [5.7.0] - 2026-08-28

### Added

- Handoff completion now records a required result summary, a machine-readable outcome, and optional changed paths, references, validation results, and remaining risks in the operator inbox and MCP health panel.

### Breaking changes

- MCP callers of `coordination_complete_handoff` must now provide `resultSummary` and `outcome`.

## [5.6.11] - 2026-08-28

### Added

- **`system_connection_status` MCP tool** — read-only diagnostic covering authentication context, `tools/list`, `resources/list`, one bounded resource read, server version, capability version, and server clock without creating a handoff.
- **Settings → Connection health panel** — shows recently active agents, last success and failure, request and refusal counts, rate-limit events, a bounded error-code summary, and stale handoffs past the coordination TTL.
- **Test connection action** — runs the diagnostic from Settings without a workspace write.

### Breaking changes

None.

## [5.6.10] - 2026-08-28

### Added

- MCP tools `workspace_get_subject_context` and `workspace_search`, gated on `workspace:read`, so an agent can resolve a claimed handoff subject in one call or find a subject by name without list-and-filter loops.
- Server-side result caps declared in each payload, structured not-found responses for unknown subjects, and redaction on both tool results.

### Changed

- `tools/list` now generates sixteen tools from the registry (seven coordination, eight workspace and Signal reads, plus `system_capabilities`).

### Breaking changes

None.

## [5.6.9] - 2026-08-28

### Added

- MCP read tools over stdio and HTTP: `workspace_dashboard_summary`, `workspace_list_tasks`,
  `signal_list_posts`, `signal_queue_snapshot`, `signal_queue_health`, and `signal_publish_preview`.
- An async tool dispatcher and registry entries for the six reads, gated on `workspace:read` with a
  structured refusal when the credential lacks that scope.

### Changed

- `tools/list` now generates fourteen tools from the registry (seven coordination, six workspace and
  Signal reads, plus `system_capabilities`).

### Breaking changes

None.

## [5.6.8] - 2026-08-28

### Changed

None. This card is an internal refactor only: dashboard summary logic moves from the route
handler into `server/domain/dashboard.ts` with no change to what `GET /api/dashboard` returns.

### Breaking changes

None.

## [5.6.7] - 2026-08-28

### Added

- `hcc://workspace/context` — a bounded MCP resource snapshot with app and capability versions,
  active workspace counts, open handoffs, queue-health headline, tools generated from the MCP tool
  registry (with required scopes and availability for the calling credential), and approval
  boundaries for operations that are never available over MCP.
- `system_capabilities` — the same descriptor as a tool call for clients with weak resource support.
- Section and include filters on the resource URI, plus declared truncation when the response would
  exceed the byte ceiling.

### Breaking changes

None.

## [5.6.6] - 2026-08-28

### Changed

- Reconciled the MCP decision record, coordination plan, and `AGENTS.md` with what shipped:
  coordination MCP (C111), operator inbox (C112), and network MCP (C113) are live; workspace and
  Signal MCP tools (MCP-C106–C108) remain unbuilt.
- Committed the three MCP capability reports and a current `docs/work-summary.md` production
  baseline.
- Recorded §9 catalog corrections: `workspace_dashboard_summary` awaits C121's dashboard module;
  `signal_publish_preview` awaits C122's async dispatch path.
- Added `docs/mcp-capability-plan.md` to the decision and coordination cross-reference lists.

### Breaking changes

None.

## [5.6.5] - 2026-08-28

### Added

- Added server-bound MCP agent identities with scoped, independently expiring and revocable
  credentials, plus a Settings panel that displays each secret only once.

### Fixed

- Refused and audited attempts to impersonate another MCP agent by changing `x-agent-label`.

### Breaking changes

None. Existing operator-session MCP bearers remain supported.

## [5.6.4] - 2026-08-28

### Added

- `npm run check:manual-version` fails when the operating manual's current-version stamps
  disagree with `package.json` — the same drift that let the manual sit at 5.4.0 through four
  releases with nothing catching it. It checks the rail footer, the masthead release badge, the
  stats block, and the colophon: four locations with no historical reading at all, each anchored
  to markup that exists for exactly one purpose. Wired into the quality gates alongside
  `check:version-bump`, under the same condition — only once a version claim is real (on `main`,
  or once a pull request leaves draft), so a draft branch legitimately holding the last-released
  version never fails it.
- A fifth candidate stamp — the sentence describing what the MCP surface currently offers — is
  deliberately not checked. Nearby prose in the exact same shape ("5.5.0 makes the write budget
  per credential...") is a historical attribution that must never move, and nothing short of
  reading a sentence for meaning reliably tells the two apart. A narrower gate that is always
  right was chosen over a broader one that would eventually cry wolf.

### Breaking changes

None.

## [5.6.3] - 2026-08-28

### Added

- Three multi-agent MCP capability reports — Claude Code, Codex, and Cursor's independent reviews
  of the MCP surface at 5.4.2 — and the consolidating `docs/mcp-capability-plan.md` that governs
  the defects and cards they found, are now tracked at `docs/`.
- Claude Code's and Cursor's own project MCP configuration (`.mcp.json`, `.cursor/mcp.json`) are
  now tracked, so opening this repository in either tool auto-configures its connection to this
  project's own MCP server. Claude Code's dev-server launch config (`.claude/launch.json`) is
  tracked for the same reason.

### Changed

- `.gitignore` now excludes `.claude/scheduled_tasks.lock` (a live runtime lock, not app state),
  `.cursor/mcp.json.portable-backup` (a redundant duplicate of the tracked config), and
  `data/.fuse_hidden*` (interrupted-write artifacts from a FUSE-backed filesystem, not app data).

### Breaking changes

None.

## [5.6.2] - 2026-08-28

### Changed

- The completed Version 4 and Version 5 planning reports (`VERSION_4_FEASIBILITY_REPORT.md`,
  `VERSION_5_CARDS.md`, `VERSION_5_FEASIBILITY_REPORT.md`) move from the repository root to
  `docs/iterations/`, alongside newer planning material already gathered there. Every card those
  reports describe (C31–C48) has already shipped; nothing in the app or its build depends on their
  root-level path.
- `docs/iterations/` also now tracks `VERSION_5B_FEASIBILITY_REPORT.md` (C85-era, baseline #259)
  and `VERSION_5_ADDITIONS_PHASE_PLAN.md` (C56–C71, filed as #183–#198) — the same class of
  already-shipped planning history as the three reports above. The raw `.docx` source behind one
  of them is left untracked; it's a binary export superseded by its own Markdown conversion.

### Breaking changes

None. This is a documentation relocation only.

## [5.6.1] - 2026-08-28

### Fixed

- MCP coordination note, complete, and cancel tools accept optional `clientRequestId` idempotency keys; an exact retry returns the first outcome and writes nothing further.
- Every coordination tool refusal and failure now carries structured error data (`code`, `retryable`, and when relevant `retryAfterMs`, `currentState`, and `requiredAction`) beside the existing plain-language error string.

### Breaking changes

None.

## [5.6.0] - 2026-08-28

### Fixed

- The operating manual is brought current to 5.5.0. It had been written against 5.4.0 and then
  edited in place for 5.4.2 without being committed, so it no longer matched the app.
- Corrected: authentication is gated by the completed production checklist, not by the bind
  address. The manual said a loopback bind is never authenticated, which is wrong for the
  supported shape where `HOST` stays `127.0.0.1` behind Caddy and login is still enforced.
- Corrected: the coordination write budget is enforced per credential and persists across
  requests. The manual described the earlier per-session limiter, which no longer reflects how
  the network transport enforces the budget.

### Added

- The manual now documents `retryAfterMs` on a write-budget refusal, and the guard that reverts a
  pull request marked ready before finalization back to draft.

### Breaking changes

None. This is a documentation-only change.

## [5.5.2] - 2026-08-28

### Fixed

- Operating manual current-version stamps now agree with the application version after the 5.5.1
  release.

### Changed

- Ignore superseded `.docx` sources under `docs/iterations/` in version control.

### Breaking changes

None.

## [5.5.1] - 2026-08-27

### Fixed

- Operator authentication now turns on when the production checklist is complete, including the
  loopback-behind-Caddy shape (`HOST=127.0.0.1`). Leaving loopback is no longer what gates login;
  local `npm run dev` without the checklist stays passwordless.

### Breaking changes

None.

## [5.5.0] - 2026-08-27

### Fixed

- The network MCP coordination write rate limit (10 per rolling minute) now actually persists
  across `POST /api/mcp` requests instead of resetting on every call, closing a gap reproduced live
  against production. The budget is enforced per credential (bearer or session), and no
  `x-agent-label` value can widen it — a nested per-label budget still applies inside that ceiling.
  Refusals report how long to wait before retrying.

### Breaking changes

None.

## [5.4.3] - 2026-08-27

### Fixed

- Marking a draft pull request ready for review before finalization (per `AGENTS.md`) now
  self-heals instead of leaving a red, unexplained check: CI converts the pull request back to
  draft and comments with the finalize checklist, rather than only failing `check:version-bump`
  with no next step spelled out.

### Breaking changes

None. Nothing in the running application changed; this is a contributor workflow change.

## [5.4.2] - 2026-08-27

### Changed

- The cutover runbook now has an explicit **production** column (C115) beside disposable staging
  (C55): SSM secrets, public HTTPS origin / Wix DNS, restore, second-device login, Drive reconnect,
  and declaring the host authoritative. README, USER_MANUAL, hosting, and deploy docs point at that
  checklist. The supported public origin is named in those docs only after the operator completes
  cutover — this release does not invent a live hostname.

### Breaking changes

None.

## [5.4.1] - 2026-08-27

### Security

- The guarantee that a loopback bind exposes no network MCP surface is now pinned by tests. On the
  passwordless loopback default, `POST /api/mcp` is unreachable and no operator bearer can be
  issued — behaviour that was already correct but that nothing verified, so a later change could
  have published an unauthenticated JSON-RPC endpoint on the app's own origin without a gate
  turning red.

### Breaking changes

None.

## [5.4.0] - 2026-08-26

### Added

- Network MCP (C113): streamable HTTP MCP at `/api/mcp` on the same origin as the API, gated by
  operator session or a server-issued bearer bound to that session, CSRF on cookie mutations, and
  the `x-agent-label` header on every call — the same coordination tool surface as local stdio, with
  bearer revocation on logout, password change, and restore.

### Breaking changes

None.

## [5.3.5] - 2026-08-26

### Added

- A cloud cutover rehearsal runbook at `docs/cloud-cutover-rehearsal.md` with the forward migration
  checklist, rollback rehearsal (freeze writes, restore a fresh hosted snapshot), failure decision
  table, and monitoring confirmation aligned with `docs/cloud-hosting.md` §8.
- `npm run cutover:rehearse` orchestrates disposable backup/restore rehearsal and optional
  frozen-write rollback verification; `--plan` prints the operator sequence without touching data.
- End-to-end coverage in `e2e/cloud-cutover-rehearsal.spec.ts` for login, authenticated workspace
  use, Drive mock reconnect, restart persistence, backup, rollback, and post-restore verification.

### Changed

- README, USER_MANUAL, and `docs/cloud-hosting.md` now describe the same supported AWS deployment
  path and distinguish **rehearsal proven on staging** from **production cutover** (operator-owned).

### Breaking changes

None.

## [5.3.4] - 2026-08-26

### Added

- Automated encrypted off-site backup transfer, safe 14-snapshot retention, scheduled restore
  rehearsals, and redacted operational health signals for the AWS host.

### Breaking changes

None.

## [5.3.3] - 2026-08-26

### Added

- Package an AWS EC2 production runtime with same-origin Caddy proxying, persistent SQLite volume
  wiring, deliberate migrations, single-writer enforcement, health checks, and fail-closed startup
  validation.
- Document a staging verification path for restart persistence, readiness, graceful shutdown,
  responsive layouts, and secret-free artifacts.

### Breaking changes

None.

## [5.3.2] - 2026-08-26

### Changed

- Drive OAuth now requests only `drive.file`. Existing folders are granted through Google
  Picker in Settings (stable Drive ids), not by pasting a URL alone.
- Pending OAuth state is stored as independent, expiring, single-use rows bound to the
  operator session that started them, so concurrent devices no longer overwrite each other.
- Disconnect and cutover guidance state clearly that Google Account revocation is separate
  from removing local credentials — required when leaving the old full-Drive grant.

### Breaking changes

- Full `https://www.googleapis.com/auth/drive` is no longer requested. Operators must revoke
  the previous grant in Google Account permissions and reconnect; restoring an old token
  ciphertext is not a scope migration.
- Root-folder selection requires Google Picker (`GOOGLE_API_KEY` and `GOOGLE_APP_ID`) instead
  of pasting a folder URL as the only path.

## [5.3.1] - 2026-08-26

### Added

- Single-operator authentication (C51): Argon2id password, HttpOnly session cookie, CSRF on
  mutations, login rate limits, bootstrap CLI (`npm run auth:bootstrap`), and a fail-closed
  non-loopback bind gate that opens only when the §5.1 checklist is complete. Loopback stays
  passwordless.

### Breaking changes

None.

## [5.3.0] - 2026-08-26

### Changed

- Cloud hosting (C50): chose **AWS** as the production target and settled the runtime contract in
  `docs/cloud-hosting.md` §11 — EC2 + Caddy (loopback `HOST`), `TRUSTED_PROXY_HOPS=1`, EBS
  `DATABASE_PATH`, SSM secret names, S3 backups, health/alerts, cost ceiling, RPO/RTO — and staged
  the inert account prerequisites in §12 / `docs/aws/c50-account-prerequisites.yaml` (IAM role,
  SSM sentinels, backup bucket, SNS, $20 budget; no compute attached). README and the user manual
  point at the decided contract; the app stays loopback-only.

### Breaking changes

None.

## [5.2.2] - 2026-08-25

### Added

- **Multi-agent MCP decision record** ([`docs/multi-agent-mcp-decision.md`](docs/multi-agent-mcp-decision.md))
  chooses local stdio Signal-over-MCP, rejects consuming provider MCP servers, and defers network MCP
  until operator authentication (C51). Follow-up implementation is split into Waves 22–24 without
  reopening the trust model.
- **Agent coordination hub plan** ([`docs/agent-coordination-plan.md`](docs/agent-coordination-plan.md))
  adds handoff-based coordination between IDE agents (C109–C112) and network MCP (C113), with wave
  milestones, time estimates, and GitHub issues #336–#340.

### Breaking changes

None.

## [5.2.1] - 2026-08-25

### Added

- **Publish now** is a separate, irreversible action from scheduled publishing: its own no-write
  preview and confirmation name the provider, accounts, effective content, media, delivery mode,
  and the absence of a scheduled instant. Post Bridge sends `scheduled_at: null` only on this path;
  Buffer stays refused until its immediate-create contract is verified. Production remains
  evidence-gated until the owner-run probe records a dated §14 result.

### Breaking changes

None.

## [5.2.0] - 2026-08-25

### Added

- After **Show preview**, public image and video addresses stay as labelled text until you choose
  **Show public media previews**. The panel says that loading a remote preview shares your IP with
  that host, and **Show text only** returns to addresses alone. Drive files, PDFs, unknown kinds,
  and signed or expiring addresses never embed; failed loads stay isolated; at most eight public
  items load in one panel at a constrained size. The browser loads those URLs directly — the server
  still fetches, proxies, and stores no preview bytes.

### Breaking changes

None.

## [5.1.2] - 2026-08-25

### Fixed

- Live Projects now lists only clients with projects matching the selected visibility. Stale
  client filters resolve to All clients instead of retaining a hidden selection, while Archived
  and All views continue to expose their appropriate choices.

### Breaking changes

None.

## [5.1.1] - 2026-08-25

### Added

- Project-filtered Status views now show their route back through Projects and the named live
  project while retaining the current Status filters. Missing, stale, archived, or merged project
  contexts keep the ordinary top-level Status breadcrumb without exposing an unrelated name.

### Breaking changes

None.

## [5.1.0] - 2026-08-25

### Added

- Signal planner cards now show **planning status** and **delivery status** as two separately named
  indicators. Delivery is derived from stored publication and target rows in one bounded local
  batch when the planner opens — no provider call, and no request per card. Cards distinguish not
  submitted, in progress, delivered, partly delivered, not delivered, unconfirmed, and finish by
  hand, with text and iconography rather than colour alone. Partial and unconfirmed answers stay
  visible instead of collapsing into scheduled or failed. The calendar remains read-only, and
  provider results still never write a post's planning status.

### Breaking changes

None.

## [5.0.1] - 2026-08-25

### Fixed

- The server no longer refuses to start once a Buffer account has been used as an explicit
  publish target or given an account-level variant. `backfillProviderAccounts` was treating any
  referenced numeric id as needing a legacy Post Bridge identity, with no exception for a modern
  account (Buffer, or a Post Bridge account resolved with a non-numeric reference) already sitting
  there — the designed, expected shape of a shared provider-neutral surrogate id space, not a
  conflict. Only a genuinely inconsistent legacy row is refused now.

### Breaking changes

None.

## [5.0.0] - 2026-08-25

Version 5.0 turns Signal into a fuller planning and publishing workspace. It brings provider-aware
publishing, richer delivery oversight, campaign figures, safer imports, more useful calendar and
Status views, and a collection of workflow and accessibility improvements into one release —
closing out every change fragment recorded since 4.0.0 (C40 onward) in one consolidated entry.

### Publish through the right provider

- Signal can route publishing accounts explicitly instead of assuming every account belongs to one
  provider. Existing Post Bridge history remains intact, while TikTok and YouTube can use Buffer
  without automatic fallback, dual submission, or first-matching account behavior.
- Publishing previews identify the provider account selected for each channel and explain whether
  the target is ready, blocked, or unavailable.
- Buffer account discovery is read-only, server-side, and limited to explicitly mapped TikTok and
  YouTube channels.
- Buffer and Post Bridge identities stay separate all the way through planning, delivery,
  inventory, and reconciliation.
- Media and platform checks are specific to the chosen provider and post shape. Unsupported
  combinations are refused before confirmation.
- A confirmed Buffer submission records each target's own remote post identity and reports
  complete, partial, failed, or unconfirmed outcomes without silently retrying an ambiguous write.
- Threads joins Signal's supported channels, wired to Post Bridge's existing capability.
- What the publishing integration deliberately does not build is recorded, with the reason and the
  concrete thing that would reopen each item.

### Keep published work under control

- Compare a submitted post with what its provider currently holds.
- Confirm separate actions to update content, update the schedule, cancel a scheduled provider
  post, or restore from Signal and resubmit.
- See provider inventory, including posts the provider holds that Signal did not create, without
  adopting or modifying them.
- Review **What needs attention** for failed, partial, unconfirmed, overdue, manually finished,
  stale, or under-covered deliveries. Acknowledging an alert never changes the underlying post.

### Understand performance in context

- **Figures** shows provider-reported views, likes, comments, and shares per delivery, plus daily
  gains where the provider supplies them.
- Signal campaigns group posts with reusable labels and aggregate the provider's own delivery
  figures.
- Campaign filters and date ranges remain bookmarkable, and **No campaign** remains visible rather
  than hiding uncategorized work.
- Refreshes are always initiated by a person. A failed refresh preserves the last complete
  known-good snapshot.

### Plan and navigate more easily

- Calendar and Signal now offer linkable Today, Week, and Month views.
- Project tasks can be reordered with drag-and-drop or an accessible position control, and the
  same order appears on the Status board.
- Status filters support multiple clients, projects, priorities, task types, and focus values,
  with selections preserved in the URL.
- Projects open on live work by recent activity and preserve filter and sort choices in browser
  history.
- Project status, Signal channels, notes, categories, and responsive Settings layouts are clearer
  and easier to scan.
- Task cards show their internal working notes separately from the client-facing description,
  clamped so a long note cannot take over the card.
- Signal editors include reusable channel presets while keeping every final channel choice
  editable.

### Import and organize with safer identities

- Signal's workbook format supports a preview-first, confirmed import of campaign content into the
  local schedule.
- A post's import identity survives edits to its copy, allowing a later import to update the
  intended post instead of creating a duplicate.
- Drive media references are resolved as metadata during preview and written with the post only
  after confirmation; preview does not read file bytes.
- Client imports can match a durable external identity instead of relying on a changeable name.
- Client merges can choose the surviving value field by field while preserving projects, aliases,
  Drive boundaries, and audit-safe confirmation.
- What Signal import deliberately leaves unbuilt is recorded, with why and the concrete thing that
  would reopen each item.

### Fixes and refinements

- The first **Show preview** action behaves consistently instead of requiring a second attempt.
- Publishing account controls remain aligned with the account names and state text they label.
- **Confirm and submit** preserves provider-specific failure and ambiguous-result handling while
  allowing valid confirmed submissions to complete.
- Signal warns about full URLs, `www.` addresses, and bare domains that X removes from post text.
- Google Drive share links are refused as public media URLs instead of being accepted as though
  they were direct media.
- Failed deliveries are no longer described as awaiting figures.
- Scheduling no longer rebuilds timezone rules for every candidate instant.
- Several layout, spacing, contrast, keyboard-focus, and production-startup defects have been
  corrected.

### Safety and privacy

- Publishing remains preview-first and explicitly confirmed.
- A failed provider never falls through to another provider.
- Ambiguous writes are not retried automatically; Signal records what is known and asks for
  reconciliation.
- Provider credentials remain server-only, and automated tests use mocked providers.
- Signal stores references and metadata, not media files. Drive viewer links are never treated as
  direct media, and preview does not fetch private Drive bytes.
- Analytics, inventory, calendar, and provider-comparison paths remain read-only.

### Configuration notes

- Post Bridge publishing continues to use `POST_BRIDGE_API_KEY` and the configured publishing
  timezone.
- Buffer uses server-only `BUFFER_API_KEY`. `BUFFER_ORGANIZATION_ID` is required only when the
  connected Buffer account exposes more than one organization.
- Buffer is an explicit route for supported accounts, not a fallback for Post Bridge.

### Breaking changes

The Signal API now represents campaigns as a list. Responses from Signal post, queue, and calendar
routes return `campaigns: { id, name }[]` instead of one `campaign` string, and Signal write routes
accept an array of campaign names. The application migrates existing campaign values automatically
without deleting the legacy stored column. Only private scripts or bookmarklets that consume the
old API field need updating.

## [4.8.6] - 2026-08-25

### Fixed

- **Confirm and submit** no longer appears ready for a Buffer plan while production Buffer writes
  stay evidence-gated. The same fail-closed reason is shown on the preview, so Confirm stays
  disabled until writes are enabled, and a Post Bridge plan still confirms when Buffer writes are
  closed.

### Added

- **Drive override for Buffer media.** Buffer refused any Drive-sourced media outright, because a
  Drive share link is an HTML viewer page even when "anyone with the link" makes the file public —
  Buffer's fetcher can never use it as-is. A channel tab now offers an explicit, per-send override
  that converts the link to Drive's direct-download address instead of refusing, with a warning
  that the conversion can fail silently at publish time: Drive interstitials larger files with a
  virus-scan page instead of the bytes, unpredictably, and Buffer fetches hours or days after the
  post is scheduled. The override is not persisted — it is threaded into the plan hash so toggling
  it invalidates a stale confirmation, and every send has to accept the risk again.

### Breaking changes

None.

## [4.8.5] - 2026-08-24

### Changed

- Update the CodeQL GitHub Actions to 4.37.8.

### Breaking changes

- None.

## [4.8.4] - 2026-08-24

### Changed

- Update the Google APIs Node.js client to 176.0.0.

### Breaking changes

- None.

## [4.8.3] - 2026-08-24

### Changed

- Update the development toolchain dependencies, including Vite, Vitest, ESLint, and the React Vite plugin.

### Breaking changes

- None.

## [4.8.2] - 2026-08-24

### Changed

- Update the production Lucide icon dependency to 1.33.0.

### Breaking changes

- None.

## [4.8.1] - 2026-08-23

### Added

- Provider-specific publish capabilities for Buffer by platform and scheduling type, separate from the Post Bridge table.
- Buffer media rules: Drive references refuse before confirmation; notification scheduling sends no media from this app; automatic TikTok may carry a direct public HTTPS URL where C83 verified create.
- Composer hint before choosing a Buffer account explaining TikTok and YouTube media limits.
- Preview shows the exact Buffer payload (`bufferWire`), delivery mode, refusals, and warnings without contacting Buffer or fetching media.

### Changed

- Mixed Post Bridge and Buffer targets in one submission refuse rather than splitting implicitly.

### Breaking changes

- None.

## [4.8.0] - 2026-08-23

### Changed

- Document the explicit Buffer route for TikTok and YouTube, and add an inert-by-default owner-run
  contract probe with guarded cleanup.

### Breaking changes

- None.

## [4.7.5] - 2026-08-23

### Fixed

- The finalization gate now actually runs. Marking a pull request ready for review triggers the
  version check, which had been unreachable: the workflow listened for pushes and openings but not
  for the moment a draft stops being a draft, so the check that only applies to a ready pull request
  was never reached in that state. A card marked ready without its version bump now fails instead of
  merging quietly.

### Changed

- Marking a pull request ready re-runs only the fast checks — audit, typecheck, lint, formatting, and
  the version rule. The test, coverage, build, and browser suites are skipped for that event, because
  it changes no file and the tree was already tested on the last push. No paid Windows run is spent
  re-proving a commit that has not moved.

### Breaking changes

- None.

## [4.7.4] - 2026-08-23

### Fixed

- Settings layout browser tests now state both Google Drive credential states explicitly, so a
  developer's local Google credentials cannot change their result.

### Breaking changes

- None.

## [4.7.3] - 2026-08-23

### Fixed

- **A change you make no longer disappears when the page finishes loading.** Two panels threw away
  what you had just done if a background request happened to answer a moment later. In **Settings**,
  pressing **Reset to defaults** could silently snap back to the palette you were replacing — and on
  the other side of a save, the sidebar could repaint itself in the old colours *after* the app had
  already told you the branding was saved. In the publishing preview, ticking an account could
  quietly untick itself while the preview settled. In both places your edit now stands, and the page
  only takes the server's version again once you have saved.

### Changed

- Browser tests wait for the page's web fonts to finish loading before clicking or measuring
  anything. The studio's two typefaces are fetched over the network and swapped in when they
  arrive, which re-lays out the page underneath a test that had already been told it was ready —
  three separate intermittent failures, all of them timing rather than a fault in the app.

### Breaking changes

- None.

## [4.7.2] - 2026-08-22

### Changed

- The quality gates run once per commit instead of twice. A commit pushed to a card branch with an
  open pull request used to trigger the whole gate on the push and again on the pull request,
  testing the same tree twice; the push trigger is now limited to `main`. What is checked is
  unchanged — every pull request still gates the merge result on Linux and Windows, and every merge
  to `main` still gates itself — and a superseded commit is now cancelled by its successor without a
  second trigger racing it.

### Breaking changes

- None. Nothing in the running application changed; this is a contributor workflow change. One
  consequence is worth knowing: a branch pushed before its pull request exists no longer runs a
  gate, so open the draft pull request with the first push, as `AGENTS.md` already asks.

## [4.7.1] - 2026-08-22

### Notes

- **Nothing in the application changed here.** This corrects what the publisher's research notes
  claim about eight open questions, and names the constraint behind them.
- **The publisher will not hold every account at once.** TikTok and YouTube cannot be connected at
  the same time as the five accounts this studio posts from — connecting them on 22 August dropped
  Facebook, Instagram, LinkedIn, Threads, and Bluesky from the list. So TikTok and YouTube post
  through Buffer, and that is a standing arrangement rather than a passing one. The notes now say
  so, with the day's account readings as the evidence.
- **Three of the eight questions cannot be answered from here at all.** They need TikTok or YouTube
  connected to the publisher that measures them, and the cap will not release the slot. Running the
  owner-only test command again would answer none of them, whatever arguments it were given. The
  notes now say that plainly, and say what the trade would cost: those three answers in exchange for
  the five accounts the studio actually posts from, which is no trade at all.
- **The other five were recorded as unanswerable and are not.** An Instagram account *is* connected,
  and Instagram is one of the platforms the publisher measures, so those five are ordinary pending
  work — waiting on a post that goes out and gets counted, not on a connection. The earlier draft of
  this correction swept all eight together; the notes now separate them and say what each half is
  waiting for.
- **Figures, media roles, and disclosure toggles are the work this touches.** The cards depending on
  those answers now each say which half they are in, so a card that can proceed is not held back and
  a card that cannot is not planned around a test run that would not help.
- **The match-quality work already shipped is unaffected**, because it was deliberately built not to
  depend on the answer.

### Breaking changes

None.

## [4.7.0] - 2026-08-22

### Added

- **Figures now say how the provider matched them.** Where Post Bridge tells this app how confident
  it is that an analytics record is about a particular piece of content on the platform, the Figures
  panel shows it below the counts as **Provider match**, beside the platform's own **Platform post**
  identifier. Both are stored with the figures, so they are there the next time the post is opened
  without asking the provider anything.
- **It is provenance, not a caveat on the numbers.** The panel prints one sentence beside the match
  saying that match quality does not qualify or discount the counts — those are the platform's own.
  The word "confidence" appears nowhere near a figure.
- **A value the app has no words for stays the provider's.** A match the app recognises reads
  *Provider match: Exact*; anything else reads *Provider value:* followed by the provider's own
  word, with its own icon. An unfamiliar value can never appear as **Exact**.
- **A delivery the provider said nothing about shows nothing.** No default, no blank line, and no
  placeholder — an absent claim is left absent. Figures stored before this release are unchanged and
  simply carry no match line.

### Changed

- The platform identifier is shown as text and is never turned into a link. The provider's own
  **Open it on …** address is still the one link on the row.
- A match value that arrives in a shape this app will not store is dropped rather than reshaped, the
  four counts are still saved, and the reason is recorded on the synchronisation's activity-log row.

### Breaking changes

None. The two new columns are nullable and added additively, so existing figures read exactly as
they did.

## [4.6.1] - 2026-08-22

### Added

- **Two accounts about to receive the same words now get a remark before you send.** Where two
  pages on one platform are given captions that match once capitalization, spacing, punctuation, and
  emoji are set aside, and the same pictures, the publishing preview says so, names the two pages,
  and asks whether it was deliberate. Nothing is blocked and **Confirm and submit** stays live —
  sometimes two audiences that barely overlap should hear the same thing, and only you know that.
  Until now anything short of a byte-for-byte match passed without comment, so a caption changed by
  one full stop read as two different posts.
- There is deliberately no similarity score behind it. Two captions either say the same words or
  they do not; "different enough" is a judgement about who reads both pages, and the app has no
  honest way to put a number on it.

### Changed

- **The refusal for identical content no longer says the publisher's guidance forbids it.** It
  says this app will not do it, which is the truth. The refusal itself is unchanged: two pages on
  one platform given exactly the same caption and pictures are still stopped before anything is
  sent, still named individually, and still offered the same two fixes — write each one its own
  content, or send to one of them.

### Notes

- Why the wording changed: the 4.6.0 note said the publisher's "own guidance restricts it". That
  restriction was never anywhere to be read. It came from how these platforms are known to behave,
  which is a good reason to refuse and a bad thing to attribute to somebody else. The rule stays
  because posting the same thing to two of your own pages is a real risk to your accounts; the
  claim that a vendor said so is gone. `docs/post-bridge-api-surface.md` §14 carries the full
  correction, and the publisher was re-checked as accepting duplicates without a word of complaint.
- Pictures and words are still judged together, in both the refusal and the new remark. Two pages
  given the same caption with different pictures are genuinely different posts and neither stops
  nor warns.
- Facebook is still the only platform that sends a caption written for one account to that account
  alone, because it is still the only one the live check could ask about. A second LinkedIn page is
  now available to ask with, and §14 records what would have to be run.

### Breaking changes

None. A post nobody has chosen accounts for is unaffected in every respect, and a post that already
sends two accounts distinct content sees no new refusal — only, where the two are very close, a
remark it can be sent straight past.

## [4.6.0] - 2026-08-21

### Added

- **One post can now go to two accounts on the same platform, each with its own wording.** Open the
  publishing preview and every channel shows the accounts connected for it, with a box beside each
  one. Tick the accounts this post should reach, press **Save accounts**, and the preview reloads
  showing what each of them would receive. Until now a channel resolved to exactly one account and
  refused if it found none or several, which is still what happens when you tick nothing.
- **Each chosen account gets its own verdict.** The preview lists them one by one — the caption that
  account would receive, and any reason it cannot be sent to — instead of one sentence about the
  platform. Two accounts can fail for two different reasons, and being told "Facebook is blocked"
  does not tell you which page to go and fix.
- **A caption written for one account is now actually sent to that account**, on Facebook. Every
  other platform still sends one set of content per platform, because that is the only place the
  publisher's behaviour has been verified — not a guess about the others.
- **An account can be given its own images**, as long as they are Drive files and the whole post
  uses Drive files. Each account's files are sent fresh with the post.

### Changed

- **Sending the same words to two accounts on one platform is refused before anything goes out.**
  The publisher itself will accept it without complaint — that was tested against the live API — but
  its own guidance restricts it, and the account that would pay for the difference is yours. The
  refusal names the two pages that clashed and offers the two real fixes: write each one its own
  content, or send to one of them. It will not suggest renaming a file or nudging some punctuation
  to slip past a check, because that changes nothing about what the two audiences actually see.
- **A page you tick is a page you meant.** Choosing accounts explicitly replaces the older rule that
  picked `G.Holmes Designs` on Facebook and refused anything ambiguous, so a page that rule would
  never have chosen is now reachable by naming it. A post where you tick nothing behaves exactly as
  it always has.
- **A channel with one unusable account sends to none of them.** If a page you chose has been
  disconnected since, the whole channel stops and says which page — rather than quietly going out to
  the ones that still work.
- **Choosing accounts, or editing what one of them receives, makes an open confirmation stale.** The
  preview has to be taken again before you can send, the same way editing a caption already worked.

### Notes

- **Only Facebook carries per-account content**, because Facebook was the only platform with two
  accounts connected when the publisher's API was tested. It is not a statement that other platforms
  cannot; it is that nobody has been able to ask them yet. Connect a second account somewhere else
  and the question can be put again.
- Titles, first comments, post shapes, and cover images stay per platform even on Facebook. Setting
  one against a single account now says plainly that its value reaches every account on that
  platform.
- An account given a public web address for its own images is refused rather than quietly falling
  back to the post's images. Per-account images work only with Drive files.
- Records of past sends written before this release do not say what each account received, and are
  left saying nothing rather than being read as "nothing was tailored" — the two are different, and
  only one of them can honestly be compared against what you have now.

### Breaking changes

None. A post where you choose no accounts plans, previews, and sends exactly as it did before,
including the confirmation fingerprint it is checked against.

## [4.5.5] - 2026-08-21

### Notes

- **Nothing in the application changed here.** This records a second run of the owner-only command
  that asks the publisher's API what it really does, and what that run saw.
- **The question that has been blocking per-account wording is now answered.** The first run, on 20
  August, could not ask it: only one account was connected on any platform, so there was no pair to
  test with. This run named two Facebook pages and asked properly. The publisher does accept a
  separate caption for each of two accounts on the same platform in a single scheduled post, and
  those captions survive being read back and edited.
- **That does not mean the feature exists yet.** Sending different wording to two accounts on one
  platform is still not something this app offers; what changed is that it is now known to be
  possible, on Facebook, so the work can be built rather than guessed at. Every other platform is
  unaffected, because no other platform has two accounts connected to test with.
- **One caution is recorded alongside the result.** The publisher's API raised no objection to two
  materially different captions going to two pages at once — but the publisher's own support
  material restricts that, and an API that accepts a request is not a platform that permits the
  post. The refusal will live in this app rather than being left to the publisher to enforce.
- The run left nothing behind: three scheduled posts and three uploaded files were created and all
  six deleted again, with a full inventory read afterwards confirming none remained. Nothing was
  published to either page.
- One earlier finding is now known to disagree between the two runs — how the publisher's post list
  filters by status — and it is written down as unsettled rather than quietly resolved in favour of
  the newer run, because the work that depends on it has not started.

### Breaking changes

None. No screen, stored record, publishing behaviour, or published post is affected.

## [4.5.4] - 2026-08-21

### Notes

- **Nothing in the application changed here.** Sending one post to two accounts on the same platform,
  each with its own wording, is still not something this app offers — and this card is the written
  reason rather than the change. The work was conditional from the day it was planned: it could only
  be built if the owner-run probe of the publisher's API first established that the publisher really
  does store a separate caption per account, and on what terms it allows two accounts on one platform
  to post at once.
- **The probe never got to ask.** When it ran on 20 August it had only one account named on any
  platform, so there was no same-platform pair to test with, and it recorded the four questions as
  unanswered rather than guessing. An unanswered question is not a "no": the publisher did not refuse
  anything. It also is not a "yes", which is why nothing was built on it.
- **So the existing behaviour stands, unchanged and for the same reason as before.** Each channel
  still resolves to exactly one account and refuses if it finds none or several; content is still
  tailored per platform; and tailoring written against a single account is still sent as that
  platform's content, with the preview saying so on the target it applies to.
- What would change the answer is a second approved account on one platform and another run of the
  probe. Until that happens the card stays open and blocked rather than being closed — the
  distinction between "we asked and were told no" and "we have not been able to ask yet" is worth
  keeping, because only one of them is settled.

### Breaking changes

None. No screen, stored record, publishing behaviour, or published post is affected.

## [4.5.3] - 2026-08-21

### Notes

- **Nothing in the application changed in this release.** The notes for 4.5.2 were incomplete: two
  cards had been merged without their entries being written, so the release that first carried
  publishing straight from Drive, and the owner-run command that probes the publisher's API,
  described neither. Both are now recorded under 4.5.2, which is the release they actually shipped
  in — rather than being given release numbers of their own that were never issued.

### Breaking changes

None.

## [4.5.2] - 2026-08-21

### Added

- **A Drive file you attach to a post is now actually published.** Until this release a Drive
  reference could be recorded and previewed but never sent; confirming a submit now streams that
  exact file straight from Drive to the publisher, and the same happens when you update or resubmit
  one. The file is re-checked against the version you approved immediately before it goes, so a file
  whose contents changed since the preview stops the send rather than going out unnoticed. Nothing is
  copied, cached, or kept here, and the publisher's own copy is temporary and made fresh every time.
- Each send now records which Drive file it used and the temporary publisher references it created,
  so a later comparison against the publisher reads what was actually sent rather than re-deriving it
  from a post that has since been edited.
- **A send that cannot be completed cleanly is refused rather than half-made**, and says which case
  it hit: media that mixes Drive files with public addresses, a file that changed after the preview,
  one past the size or length the publisher accepts, a transfer that redirected, timed out, or
  stopped part-way. Where something did land before the stop, the count of what landed is reported
  instead of being left for you to find.
- **A cover image and a thumbnail can now be a file in the connected Drive rather than a pasted
  address.** Each one is stored per platform — and per account where you tailor one — with the file's
  name, type, size, and version, the same evidence a post's own media has carried since the last
  wave. Pick one from a Drive link or type a public address; **Recheck** asks Drive again on purpose,
  and a file whose contents changed since you approved a send makes the open confirmation stale
  rather than going out quietly.
- The publishing preview now names each target's cover or thumbnail, and says plainly whether the
  publisher will carry it.
- **An owner-run command that establishes what the publisher's API actually does, before anything is
  built on it.** `npm run probe:post-bridge` asks the seven questions the media and analytics work
  depends on — whether a post can carry a different caption per account, what the upload flow really
  requires, whether a YouTube thumbnail or an Instagram cover is accepted, how the post list pages,
  what an analytics window means, and whether the disclosure fields stick — and writes down what it
  saw.
- Because it is a write against real connected accounts, it refuses to run without every one of: the
  API key in the environment rather than on the command line, `--yes`, an explicit statement that the
  accounts are disposable or approved, a send time at least 48 hours away, a label nothing in the
  publisher is already using, every account named by its own id, and the label typed back at a
  prompt. There is no default account and nothing is chosen for you. Run without `--live` it contacts
  nothing at all and just prints what it would do.
- Everything it creates is deleted when it finishes, including if it stops early, and then it re-reads
  the whole list of scheduled posts to prove they are gone rather than assuming it. Anything the
  publisher will not let it delete is listed by id with what to do about it.
- It uploads three committed files and nothing else — two flat-colour images and a one-line PDF, all
  small enough to read in a diff — or a disposable video you point it at. It never touches a campaign
  asset, and it records each file's fingerprint rather than its contents.

### Changed

- **The publisher's own cover and thumbnail fields are still not used, and now the app says exactly
  why.** The live probe could not establish that Post Bridge accepts either one, and its current
  support material says custom external YouTube thumbnails are unavailable — so nothing is sent for
  either role. You can still choose one where the publisher names the field at all (an Instagram
  cover, a YouTube thumbnail): it is stored and version-checked, and every place it appears says it
  is held rather than delivered. It will go out when the behaviour has actually been verified, with
  no second setup on your part.
- A cover or a thumbnail is refused rather than warned about when the publisher would reject it
  outright: it has to be a still image, and at most 8 MB.
- A **LinkedIn PDF publishes as a document post with its title**, end to end — the one media
  behaviour the live probe did verify. This is the ordinary Drive media path plus the title the
  editor already collected; nothing new to fill in.
- The research note `docs/post-bridge-api-surface.md` now records the first owner-run live session:
  29 bounded requests, three posts and three provider assets created and deleted, an independent
  inventory proving the posts absent, and no leftovers. Its dated matrix separates the upload,
  listing, PDF, and Facebook behavior the provider verified from the lifecycle, platform, and
  analytics questions that remain unresolved.

### Fixed

- A media address that is not an address at all is refused with a reason instead of failing as a
  server error.

### Notes

- Covers and thumbnails you had saved as plain addresses are carried over automatically the first
  time the app starts, and the old columns they lived in are left empty for good, so there is one
  place a cover lives rather than two.
- TikTok's and Pinterest's cover fields are untouched; they belong to platforms whose other settings
  are not built yet.
- The probe command changes nothing about how the app publishes. It adds a command you run yourself
  and a document section; no publishing rule, capability, or limit moved because of it, and none will
  until the probe actually establishes something.
- A still-unverified claim still leaves the work that depends on it blocked. The live evidence unlocks
  only the behaviors it actually observed; it does not turn a successful cleanup into proof of
  24-hour expiry, invent analytics rows, or infer behavior for accounts and media not supplied.

### Breaking changes

None.

## [4.5.1] - 2026-08-20

### Added

- A Signal post's media can now be a **file in your connected Drive**, not only a public address.
  Open a post, paste a Drive share link under **Add a Drive file by link**, and the file is checked
  straight away: the composer shows its name, type, size, and when it was last checked, and links
  out to Drive for anything else. Nothing is uploaded, downloaded, or copied — the app records what
  the file is, not the file.
- **Recheck Drive file** confirms a reference against Drive again whenever you want to know it is
  still what you planned. It records what came back and moves the post, so a publish preview taken
  before the change stops matching and has to be looked at again. A recheck that fails leaves the
  reference and its last known details exactly where they are and says why underneath them — it
  never removes or silently rewrites your media.

### Changed

- A Drive video, image, or PDF is now recognised for what it is when a post is previewed, because
  the type comes from what Drive reported rather than from a share link that carries no file
  extension. Preview still contacts nothing: no Drive call, no provider call, no bytes.
- A Drive link that cannot be used says exactly why rather than failing vaguely — a folder, a
  shortcut that does not lead to one file, a Google Doc or Sheet with nothing to publish, a type the
  publisher will not take, a file with no size, or one over the size this app will bind to. A link
  from anywhere other than Drive is refused before anything is looked up.
- Editing a post no longer risks disturbing its Drive references: an ordinary save keeps each one
  exactly as it was last checked, and only a recheck replaces it.
- Fixed alongside: a partial edit sent to the API — one naming only the text, say — no longer
  cleared the fields it did not mention. Channels, media, campaigns, and the scheduled date now stay
  as they were, which is what a partial edit always claimed to do.

### Breaking changes

None. Every existing media reference is a public address and stays one, with nothing to change and
nothing to re-enter.

## [4.5.0] - 2026-08-20

### Changed

- **The rule about media has been narrowed, and nothing in the app behaves differently yet.** The
  older claim — Command Center never uploads, downloads, or proxies media — has been replaced
  everywhere it appeared with the claim that is actually being kept: **this app stores no media
  files, serves no media bytes, and holds no media bytes at rest.** Referencing, storing, and
  serving are still refused.
- One narrow exception has been decided and is **not built**: when you confirm a submit, the server
  may stream a single media file you selected from Drive straight to the publisher, keeping no copy
  and writing nothing back to Drive. Until that work lands there is no path in this app that moves
  a media file at all.
- **Files has not changed and is not part of that exception.** Drive browsing stays read-only and
  scoped to a project's own folders, with no upload, download, move, rename, or delete — exactly as
  before.
- The Signal composer's media hint now reads "Signal stores the references, not the files", and the
  user manual says the file is never copied here rather than promising it will never be read.
  Previewing a post still contacts nothing: the preview has never fetched a media file on the
  server and that does not change.

### Added

- Two documents behind the publishing work now live in the repository:
  `docs/post-bridge-api-surface.md`, a dated research note recording what the provider's API
  actually offers, and `docs/post-bridge-integrations-plan.md`, the reviewed sequencing for what to
  do about it. `docs/publishing-integration.md` links both and remains the record that decides how
  publishing behaves.
- The decision record now states plainly that a publisher-side media id is temporary — recreated
  every time a post is submitted, updated, or resubmitted, never a lasting reference — and that the
  vendor's expiry timing is documented but has not been verified against the live service.
- Every other capability the research note found is recorded as unverified, so the publishing
  capability table keeps refusing what it refuses today until each one is checked in turn.

### Breaking changes

None. No feature, screen, endpoint, stored value, or publishing capability changed in this release.

## [4.4.0] - 2026-08-18

### Added

- The Signal editor now shows **Delivery** beside the planning status, with one row for every
  account a post was sent to. Each row says how that delivery gets there — automatic publishing, a
  provider draft, a finish you have to do in the platform's own app, or nothing at all because no
  provider reaches that channel — and how far it actually got, in words rather than stored codes.
  When two accounts go out and one of them fails, both say so and the failure names its reason
  beside the account it belongs to.
- A delivery that needs you to finish it somewhere else now says which application to open and what
  is waiting in it, and **Mark … finished** records that you did. That records the delivery only:
  it never touches the post's own status.
- Blog now appears in Delivery instead of being left out, saying plainly that nothing was sent and
  pointing at **Mark published**, which is still the way to record that you posted it yourself.

### Changed

- The editor's **Status** field is now labelled **Planning status**. The three values are unchanged
  and it is still yours alone: nothing the provider reports has ever written it, and now the page
  says so.
- Delivery is checked with the provider on its own once a post's scheduled time has passed, waiting
  longer between each check and stopping after six rather than asking for ever. The section shows
  when it last checked and when it will next, and **Refresh delivery** still asks immediately —
  including after the automatic checks have stopped.

### Breaking changes

None. Existing publication records keep their delivery route recorded as automatic publishing,
which is what every connected platform does today, and no post's status changes.

## [4.3.2] - 2026-08-18

### Added

- Signal post editors now offer **Duplicate to unscheduled queue**. The copy keeps the original
  content, media, campaign, channels, format, CTA, and posting time, and lands in the queue as a
  new draft with no date. Publication and delivery history stay on the original.
- **Suggest next open slot** reads the Signal schedule and proposes the next date at that post's
  time that no other post already occupies. The suggestion is shown until you confirm it; occupancy
  is checked again at that moment, and a taken cell is refused rather than double-booked.

### Breaking changes

None.

## [4.3.1] - 2026-08-18

### Added

- **One post can now read differently on every channel.** Signal's editor has a **Per-platform
  content** section with a panel for each platform the post's channels reach. A platform starts from
  the post and keeps only what you change: a short caption for X with the link as a first comment, a
  longer one for LinkedIn, a real title for YouTube instead of the caption standing in for it. An
  account override can sit over a platform's, edited from that account's own preview tab. Clearing a
  field restores the post's own content rather than sending nothing.
- **You are offered only the fields the provider will actually carry.** X has a first comment,
  YouTube has a title, Instagram and Facebook have a story placement, and no platform offers a chosen
  cover image or thumbnail because none accepts one. The same rule that hides a control refuses it if
  it arrives another way, so the form and the API never disagree about what is possible.
- **Per-platform media selection**, chosen from the media the post already carries and in the post's
  order. Choosing none is allowed: that is a platform that receives the text alone.
- **A synthetic-media disclosure** you can turn on per platform. No platform gives this provider a
  disclosure field, so the disclosure is written into the caption — and the character count and the
  caption limit are both measured against the caption you will actually send, so a disclosure that
  pushes X past 280 characters is refused before the send rather than after.
- **A preview that shows each target separately, and only when you ask for it.** **Show preview** is
  the only thing that loads anything from the internet or contacts the provider. It opens with every
  channel's verdict in one list, then one tab per target account: the exact text that account
  receives, a note beside any value an override decided, the title and first comment, the media in
  that target's order, the post's date and time in the configured zone beside the instant the
  provider is given, whether the provider sends it or hands it to the platform's app to finish, and
  that target's own warnings and refusals.
- Preview media is shown small, because a preview is for checking the order and the crop. **A video
  never starts on its own** — it takes a second, deliberate press and then arrives with ordinary
  controls. Media that cannot be shown says so and still offers its address, rather than leaving a
  gap.

### Changed

- Two limits the provider imposes are now stated as refusals rather than discovered afterwards. It
  sends one set of media per submission, so channels given different media are refused and named;
  and it carries one set of content per platform, so an account override is delivered as its
  platform's content, which the preview says on the target it applies to.
- A caption limit, a media count, and a post shape are now checked against what a platform will
  actually receive rather than against the post, so an override that breaks a limit is caught in the
  preview.
- Media selected for a platform that the post no longer carries is left out and reported, never
  silently sent.
- Previewing is held back until per-platform content is saved, the same way it already waited for the
  post itself. **Preview publishing** is now called **Show preview**.
- Editing a platform's content between previewing and confirming refuses the confirmation, exactly as
  editing the post already did.
- The publishing preview renders media in your browser, so production responses now allow media from
  an `https:` host — the same allowance a sidebar logo already had for images. Nothing is fetched by
  the server: Command Center still never uploads, downloads, or proxies a media file, and responses
  carry `Referrer-Policy: no-referrer` so a media host is never told which page asked for it.

### Breaking changes

None. A post with no per-platform content is planned, previewed, and submitted exactly as before.

## [4.3.0] - 2026-08-16

### Added

- **Merge one client into another.** When the same client ended up in the list twice, **Merge
  client** on the duplicate's page moves every one of its projects — with their tasks,
  checklists, dependencies, categories, ordering, dates, and Drive links unchanged — to the
  client you are keeping, in one all-or-nothing step. A summary names both clients and lists
  every project that will move, including archived and completed ones, before anything is
  written; if that summary goes out of date while it is on screen, the merge is refused and the
  current one is shown to confirm again.
- The duplicate is archived and records where its work went, rather than being deleted. Its own
  contact details and notes stay readable on it and are never combined with the client you kept,
  whose details win. Its client page links to the survivor, and its card in the Clients list
  shows a merged badge in place of the Unarchive button.
- A merged client's name becomes an alias: a later campaign playbook naming it attaches to the
  client its work went to, instead of recreating projects beneath the archived duplicate. A
  client of that name that was never merged still wins, and the import preview names which rule
  matched.

### Changed

- Google Drive is untouched by a merge — no folder is moved, renamed, created, or deleted, so
  every project's files still open where they always did and the duplicate's own client folder
  stays in Drive. A later **Sync to Folder** will create a folder for a project that never had
  one under the client you kept.
- A merged client can no longer be unarchived, chosen as the destination of another merge, or
  handed a project back by editing one — any of those would quietly undo the merge. Editing a
  project's client is now held to the same rule as creating one: the client has to be active.
- There is no undo. Recover from a database backup if a merge was a mistake.

### Breaking changes

- None.

## [4.2.2] - 2026-08-14

### Added

- Add an explicit preview-and-confirm Post Bridge publishing flow for scheduled Signal posts, with configured-timezone conversion, account and media preflight, durable per-target delivery records, and safe handling of ambiguous submissions.

### Breaking changes

- None.

## [4.2.1] - 2026-08-13

### Added

- Signal posts can now keep, reorder, and display ordered public media URL references without
  uploading, downloading, or storing the files themselves.

### Breaking changes

- None.

## [4.2.0] - 2026-08-13

### Changed

- Reconciled the publishing decision record with the proven social-media publisher, including the
  seven-channel media prerequisite, provider boundaries, preflight rules, and account safety rule.

### Breaking changes

- None.

## [4.1.10] - 2026-08-13

### Changed

- Contributors no longer claim a version number while a card is under review. A branch keeps its
  pull request in draft and describes what it changed in `changes/<issue>.md`; the person merging
  it assigns the version and folds that text into this file at merge time, when the number is
  finally knowable. Concurrent cards stop colliding over the same four release files, and no card
  needs a follow-up commit to renegotiate a number another card took first.
- The version-bump check runs on `main` and on pull requests that are ready for review. Draft pull
  requests are exempt by design, which is what lets a card defer its number. Every other quality
  gate runs exactly as it did.
- Dependency-update branches follow the same path. They no longer need a hand-added bump commit to
  go green.

### Breaking changes

- None. Nothing in the running application changed; this is a contributor workflow change.

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

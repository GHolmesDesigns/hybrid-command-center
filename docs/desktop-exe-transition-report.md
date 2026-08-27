# Terminal-to-Desktop EXE Transition Report

**Prepared:** 2026-08-18  
**Revised:** 2026-08-26 — verified against `main` `c9036c7`, `package.json` 5.4.0  
**Scope:** Windows-first desktop distribution for the single-operator Hybrid Command Center  
**Status:** Planning report; no desktop implementation is included. **Not an approved direction** —
see [Relationship to the cloud track](#relationship-to-the-cloud-track).

> **Revision note.** The 2026-08-18 draft was written before C51–C55 and C113 landed (all on
> 2026-08-26). Four of its premises were stale within eight days: the app had no authentication, the
> Drive scope migration was pending, there was no cloud runtime, and MCP was stdio-only. Every claim
> below has been re-checked against `c9036c7`. Sections changed by that re-check are marked
> **[revised 08-26]**.

## Executive summary

Hybrid Command Center can become a normal Windows desktop application without rewriting its React UI, Express API, business rules, or SQLite repositories. The recommended path is an Electron desktop shell, packaged with Electron Forge as a signed Squirrel.Windows installer. The installed product would include its own compatible Node and Chromium runtimes, launch from the Start menu or a desktop shortcut, and require no terminal, separate Node.js installation, or manual `npm` commands.

The recommended runtime retains the existing production shape inside the desktop process:

1. Electron starts the local Express application on an operating-system-assigned loopback port.
2. Express serves the existing built Vite client and API from that same origin.
3. Electron opens that local origin in a locked-down `BrowserWindow`.
4. SQLite, backups, logs, and desktop configuration live in a per-user writable application-data directory, never beside the installed executable.
5. Google authorization opens in the user's default browser and returns through a temporary loopback callback suitable for a desktop OAuth client.

This is an installation and usability project, not cloud hosting. The database remains on one Windows computer; the application is unavailable when that computer is off; it does not gain remote or multi-user access. Google Drive remains authoritative for project files.

Packaging is the smallest part of the project. Data migration, OAuth, secret storage, desktop security, installer signing, update safety, and installed-application testing determine whether the `.exe` is production-ready.

## Relationship to the cloud track

**[added 08-26]** This report does not describe the direction the repository is currently building.

[`docs/cloud-hosting.md`](cloud-hosting.md) is a **decided** record (C20 / #77, contract settled in
C50 / #176). It states that a desktop package "solves installation only and does not satisfy 'lives
in the cloud' on its own," and names a desktop package as explicitly *not* the first cloud shape.
Since this report was drafted, that decision has been funded through to delivery:

| Card | Shipped | What it added |
| --- | --- | --- |
| C51 / #177 | 5.3.1 | Single-operator authentication — argon2id, session cookies, CSRF, login rate limiting |
| C52 / #178 | 5.3.2 | Drive OAuth narrowed to `drive.file` with session-bound pending state and Google Picker |
| C53 / #352 | 5.3.3 | Packaged and validated production cloud runtime |
| C54 / #353 | 5.3.4 | Automated encrypted off-site backups and recovery monitoring |
| C55 / #354 | 5.3.5 | Cloud cutover, rollback, and operator recovery rehearsal |
| C113 / #355 | 5.4.0 | Network MCP at `/api/mcp` behind operator auth |

Every one of those cards invests in the **networked, authenticated** shape. The desktop direction
invests in the **loopback, unauthenticated** shape. They are not complementary by default: the
sections below show three places where a desktop build silently takes a *different* branch of the
same code (`authRequired`), not a shared one.

Before any desktop card is opened, one of these has to be recorded as a decision:

1. **Desktop replaces the cloud track.** Requires an amendment to `docs/cloud-hosting.md`, which is
   currently marked decided, and writes off C53–C55.
2. **Desktop is a second supported target.** Doubles the support matrix — two auth models, two OAuth
   client types, two MCP transports, two backup stories, two release pipelines. This report's
   four-to-six week estimate does **not** cover that; it costs materially more.
3. **Desktop is deferred.** This report stays a reference and no card is opened.

The technical analysis below is sound on its own terms and holds under any of the three. It is not a
recommendation to proceed.

## Current state

**[revised 08-26]** Re-verified against `main` `c9036c7`.

The repository is already close to a packagable architecture:

- The client is React/Vite and communicates through relative `/api` requests.
- The server is Express and already serves `dist/client` in production mode — `server/index.ts`.
- Operational data is stored in one SQLite database through Node's built-in `node:sqlite` API —
  `DatabaseSync` in `server/db.ts`.
- Backup, restore, migration rehearsal, graceful shutdown, unit/integration tests, Linux end-to-end coverage, and Windows end-to-end coverage already exist.
- Production-style use still requires Node 24+, package installation, database migration, a terminal command, and a browser opened at `http://localhost:8787`.

### The `authRequired` branch governs the desktop shape

The single most important fact for this report, and the one the original draft got wrong. As of C51
(and clarified by C114), the application **does** have authentication, and `server/app.ts` derives
whether to enforce it from the §5.1 / §11 checklist — not from leaving loopback:

```
const authRequired =
  options.enforceAuth ??
  authenticationConfigured({ sessionSecret, operatorPasswordHash, appOrigin, ... });
```

A desktop build binds `127.0.0.1` on port `0` and does **not** load the production checklist, so
`authRequired` is **false**. Three consequences follow, and each is load-bearing below:

1. **No login prompt.** The desktop build inherits the unauthenticated incomplete-checklist path for
   free. There is no operator-password UX to design. This is a genuine simplification.
2. **No session to bind OAuth state to.** `oauth_pending_states.session_token_hash` is populated only
   when operator auth is on, so a system-browser callback validates on PKCE and state alone. The
   desktop OAuth flow described below works unmodified.
3. **Network MCP does not exist.** `/api/mcp` is mounted only inside `if (authRequired)`, so the
   desktop build has no network MCP at all. See [Network MCP on the desktop](#network-mcp-on-the-desktop-unresolved).

Verified empirically — `createApp(db)` with the incomplete local checklist returns `404` for
`POST /api/mcp` and `400 {"error":"Authentication is not required on this host."}` for
`POST /api/auth/mcp-bearer`. With the checklist complete and `HOST` still loopback, auth is on
(C114).

The non-loopback bind gate is therefore no longer "loopback because there is no authentication." It
is a five-item checklist in `server/config.ts` — `SESSION_SECRET` (≥32 chars),
`OPERATOR_PASSWORD_HASH`, an `https` `APP_ORIGIN`, `PRODUCTION_TLS_TERMINATED=true`, and
`TRUSTED_PROXY_HOPS` set explicitly. Production keeps `HOST` on loopback behind Caddy and turns
auth on from that same checklist; non-loopback binding is a foot-gun the production preflight
still refuses.

### Defaults that cannot be copied into an installer

- `DATABASE_PATH=./data/command-center.db` is relative to the process working directory. An installed application must use an explicit per-user writable path.
- Port `8787` can collide with another process. A desktop instance should request an available loopback port. **[revised 08-26]** Note the tension this creates with MCP client configuration, below.
- `.env` is an operator-managed file and includes the Google token-encryption key. A normal desktop installation needs first-run configuration and operating-system-backed secret protection.
- Google Drive currently uses a web-server OAuth client and redirects the application window to Google's authorization page. Desktop OAuth should use the system browser and a desktop-client loopback callback.
- Backup and restore are terminal scripts. Their underlying services can be reused, but a terminal-free product needs safe in-app entry points or a documented support utility.
- External links currently rely on browser behavior. Electron must explicitly prevent untrusted navigation inside the privileged application window.
- **[added 08-26]** Every entry point in `package.json` runs TypeScript directly through
  `node --experimental-strip-types`. Nothing in the repository is transpiled ahead of time. Whether
  Electron's main process can load stripped TypeScript from inside an ASAR archive is unproven and
  is a first-order packaging risk — see workstream 1.
- **[added 08-26]** `argon2` is a compiled native addon (`binding.gyp`). It ships N-API prebuilds, so
  it should load under Electron without an ABI rebuild, but a `.node` binary cannot be loaded from
  inside an ASAR archive and must be unpacked. It loads unconditionally at import
  (`server/app.ts` → `server/auth/service.ts` → `server/auth/password.ts`) even on the desktop path
  where it is never called.

## Recommended technical direction

### Use Electron rather than a native rewrite

Electron is the lowest-risk fit because the application and its required `node:sqlite` runtime are already TypeScript/Node based. The supported Electron 43 line includes Node 24, matching the repository's current runtime requirement. The implementation should pin the latest supported stable Electron release at the time work begins and verify `node:sqlite`, Google APIs, backup/restore, and shutdown behavior in the packaged runtime.

**[revised 08-26]** "Already TypeScript/Node based" overstated the ease of this. The repository is
not pure JavaScript-on-Node in the way that phrasing implies: it runs **untranspiled TypeScript**
via `--experimental-strip-types`, and it carries at least one **compiled native addon** (`argon2`).
Both cross the packaging boundary. Neither is fatal, and both must be proven in workstream 1 rather
than discovered in workstream 2. The Electron-43-includes-Node-24 pairing was not verified during
this revision and should be confirmed against the release notes at the time work begins.

Tauri is not recommended for the first desktop release. It would reduce installer size, but the existing Express and SQLite implementation would still need a separately managed Node sidecar or a Rust rewrite. Either choice adds a second runtime boundary and substantially more migration and test work without improving the first release's user outcome.

### Retain the local HTTP boundary

The first desktop release should preserve the tested Express API rather than replace every client request with Electron IPC. A desktop entry point should create the database and Express app directly, listen on `127.0.0.1` with port `0`, obtain the assigned port, and then load that same-origin URL.

Add a random launch-bound authorization value to desktop API requests so another local process or an unrelated browser page cannot operate the API merely by finding the port. Continue enforcing loopback-only binding. This preserves the web/server separation while tightening the local desktop boundary.

**[revised 08-26 / 08-27]** This recommendation survives C51 and C114 intact, and is now more
important than when it was written. Because a desktop launch leaves the production checklist
incomplete, `authRequired` is false and the operator session layer is inactive — the launch-bound
value is the *only* thing standing between another local process and a fully open API. It is not
defence-in-depth here; it is the sole control. It must not be confused with, or reuse the storage
of, the C113 MCP bearer (`operator_mcp_bearers`), which is bound to an operator session that does
not exist on this path.

### Network MCP on the desktop (unresolved)

**[added 08-26]** C113 put MCP on the same Express origin at `/api/mcp` — no second port, process,
or origin. Architecturally that is the shape a packaged desktop app wants, and it removes the
"spawn and supervise a second server" problem the original draft never addressed.

It is nonetheless unavailable on the desktop. The route is mounted only inside `if (authRequired)`,
and `POST /api/auth/mcp-bearer` returns `400` when auth is not required. A desktop build with an
incomplete checklist therefore has **no network MCP**, and MCP falls back to stdio — which is
`npm run mcp`, a terminal command, in a product whose entire premise is the absence of a terminal.

Three options, none free:

1. **Drop MCP from the desktop target.** Cheapest and most honest for a first release. Requires
   saying so in the scope section and in the manual, because MCP is a shipped product capability.
2. **Spawn stdio MCP as an Electron utility process**, with a generated client configuration the
   user can copy from Settings. Leaves `authRequired` untouched, keeps the security model as-is, and
   is the recommended path if MCP must work on desktop.
3. **Mount network MCP on the desktop.** Requires decoupling the route from `authRequired` and
   inventing a desktop-local credential — which collides with the launch-bound authorization value
   above, leaving two bearer schemes on one origin. Not recommended.

Option 3 has a second defect created by this report's own design: **port `0` means the origin changes
on every launch.** Any external MCP client configured against `http://127.0.0.1:<port>/api/mcp`
breaks on restart. Resolving it means either a fixed desktop port — giving up the collision
avoidance argued for above — or a discoverable port file written to `userData`. Option 2 avoids this
entirely, because stdio has no port.

**This report does not decide between the three.** It is a prerequisite decision, not an
implementation detail, and it belongs in the list below.

### Separate packaged assets from writable state

Packaged code and frontend assets may be stored in Electron's ASAR package. Writable state must be outside it. Use an application-specific subdirectory below Electron's `userData` path for:

- the live SQLite database and its WAL/SHM sidecars;
- database backups and restore safety copies;
- non-secret desktop settings;
- rotating application logs; and
- migration markers and first-run state.

Do not silently move or delete the existing `data/command-center.db`. The desktop application should offer a deliberate first-run import from a verified backup or from the existing database after the terminal-launched copy has been stopped.

### Use desktop-safe OAuth and secret storage

Google recommends an installed application's system-browser authorization flow with a loopback IP callback on a random available port. The desktop work should:

- create or select a Google OAuth **Desktop app** client;
- open Google authorization in the default browser, not inside Electron;
- keep PKCE and single-use, expiring state validation;
- listen only on `127.0.0.1` for the callback;
- show a minimal “authorization complete; return to the app” browser page;
- notify or poll the Electron window so Settings refreshes without loading the full app in a second browser window; and
- handle cancellation, timeout, duplicate callbacks, and application shutdown during authorization.

A distributed desktop OAuth client cannot rely on a bundled client secret being confidential. The existing Google tokens should remain encrypted at rest, but the encryption key should be generated on first run and protected using Electron `safeStorage`, which uses Windows DPAPI. Migrating an existing workspace requires the old `GOOGLE_TOKEN_ENCRYPTION_KEY` once: decrypt the imported tokens, re-encrypt them under the desktop-managed key, verify the connection, and avoid retaining the old key.

~~The planned move from the full Drive scope to `drive.file` plus Google Picker is a separate security
change. It can be coordinated with desktop OAuth, but combining both changes increases review and
regression scope; sequence them explicitly rather than letting packaging change scopes
accidentally.~~

**[revised 08-26] Superseded — already shipped.** C52 / #178 landed the scope migration on
2026-08-26. `DRIVE_OAUTH_SCOPE` is `https://www.googleapis.com/auth/drive.file` only
(`shared/drive-oauth.ts`), and Google Picker is wired at `client/src/drivePicker.ts`. There is no
sequencing decision left to make, and workstream 3 is smaller than originally scoped by exactly this
amount.

Two consequences for the desktop work, in opposite directions:

- **Easier.** The desktop OAuth client inherits the narrow scope. There is no scope change riding
  along with packaging.
- **Harder.** `server/drive/oauth.ts` notes that restoring an old full-Drive token ciphertext "is not
  a scope migration — reconnect." A first-run import from a pre-C52 workspace backup therefore
  cannot silently carry Drive access forward: it must detect pre-C52 token ciphertext and route the
  user to a reconnect rather than a re-encrypt. The token re-encryption path described above handles
  the key change but **not** the scope change, and the two must not be conflated.

One item above needs no change but is worth pinning: "keep PKCE and single-use, expiring state
validation" remains correct. C52 moved pending state into the `oauth_pending_states` table with a
`session_token_hash` column, but that column is populated only when operator authentication is on.
On the desktop's loopback path it is null, so the system-browser callback validates on PKCE and
state alone, exactly as this section describes.

## Delivery workstreams

### 1. Desktop runtime foundation

- Add an Electron main-process entry point and Forge configuration.
- Add development and packaged launch commands without changing `npm run dev` for contributors.
- Refactor server startup into a reusable function that returns the listener and assigned origin.
- Enforce single-instance behavior and focus the existing window on a second launch.
- Tie window close, app quit, server close, SQLite close, and in-flight operations into one tested shutdown owner.
- Show a useful native error dialog if configuration, migration, database open, or server startup fails.
- Confirm the packaged Electron Node runtime supports every built-in Node API in use.
- **[added 08-26]** Prove `node:sqlite` (`DatabaseSync`) opens, migrates, reads, and writes inside the
  packaged Electron runtime. This is the highest-risk item in the project and belongs first.
- **[added 08-26]** Prove the TypeScript strategy. Every entry point currently runs untranspiled
  `.ts` through `--experimental-strip-types`; Electron's main process has its own module loading
  path, and stripped TypeScript inside an ASAR archive is not a solved default. Decide in this
  workstream whether the desktop build strips at runtime or introduces a build step — and if it is a
  build step, that is a change to how the whole repository ships, not a desktop-only detail.
- **[added 08-26]** Prove `argon2` loads. It is a native addon and must be `asarUnpack`ed; it is
  imported unconditionally even though the desktop path never calls it.

**Exit condition:** an unpackaged desktop development build launches the real app in a window, performs normal CRUD, and exits without leaving a process or database handle open. **[revised 08-26]**
`node:sqlite`, the TypeScript loading strategy, and `argon2` are each demonstrated in a *packaged*
build before workstream 2 begins — the point of this card is to fail fast, and all three fail late
if deferred.

### 2. Desktop data, configuration, backup, and migration

- Introduce a runtime-path provider so server modules do not infer writable paths from the current working directory.
- Initialize and migrate the database automatically on first launch.
- Move logs and backups to defined per-user paths and surface those locations in Settings or diagnostics.
- Add “Back up now,” “Import existing workspace,” and “Restore backup” flows around the existing tested services, with confirmations and app restart where required.
- Detect an already running terminal copy or locked database and fail safely.
- Preserve the repository's SQLite integrity checks, safety backup before overwrite, Drive references, and encrypted-token rules.
- Define uninstall behavior: uninstalling the program should preserve user data by default; removing workspace data must be a separate explicit action.

**Exit condition:** fresh install, update, uninstall/reinstall, backup, restore, and legacy-workspace import preserve the expected records and never modify Drive files.

### 3. Desktop OAuth, secrets, and external links

- Implement the Desktop app OAuth client and external-browser loopback flow.
- Replace `.env`-only desktop setup with a first-run/settings experience for optional integrations.
- Generate and protect the local token-encryption material with Windows DPAPI through Electron `safeStorage`.
- Migrate existing encrypted Drive tokens only after proving the supplied legacy key can decrypt them.
- **[added 08-26]** Detect pre-C52 (full-Drive-scope) token ciphertext on import and route the user
  to a reconnect. Re-encrypting a pre-C52 token under the desktop key produces a working decrypt of a
  token carrying the wrong scope — the key migration and the scope migration are different problems.
- Route Drive folders, files, `mailto:` links, logo URLs, and other approved HTTPS destinations to the system browser.
- Deny unexpected navigation, pop-ups, permission requests, downloads, and new windows.
- **[added 08-26]** Confirm Google Picker functions inside the hardened `BrowserWindow`, or route it
  to the system browser. Picker is now a required part of attaching pre-existing Drive folders under
  `drive.file`; the CSP and navigation rules in workstream 4 are written to block exactly the kind
  of third-party frame Picker relies on.

**Exit condition:** Drive can be configured, connected, restarted, disconnected, and reconnected without a terminal, embedded Google login, exposed secret, or stray browser copy of the application.

### 4. Electron security hardening

- Keep `nodeIntegration` disabled, context isolation enabled, and renderer sandboxing enabled.
- Avoid a broad preload bridge; expose only narrowly validated desktop operations that cannot remain ordinary HTTP actions.
- Retain the production Content Security Policy and restrict `connect-src` to the app's assigned loopback origin and required HTTPS services.
- Validate every IPC sender and argument if IPC is introduced.
- Apply Electron fuses: disable RunAsNode, require ASAR integrity, and disable avoidable inspection or environment override paths where supported.
- Use ASAR packaging but unpack only resources that demonstrably require filesystem access.
  **[revised 08-26]** Native addons are a second, independent reason to unpack: `argon2` ships a
  `.node` binary that cannot be loaded from inside an archive. "Requires filesystem access" does not
  describe this case and would not catch it.
- Never render arbitrary remote pages in the application window.
- Add a release dependency policy because each desktop release ships Electron, Chromium, Node, and npm dependencies together.
- **[added 08-26 / revised 08-27]** Add a regression test asserting that `/api/mcp` is **not**
  reachable when `authRequired` is false. Shipped with #356 / #361 against the incomplete-checklist
  derivation (and kept current by C114): `server/mcp/http.test.ts` constructs `createApp(db)`
  without `enforceAuth`, so mounting the route above the gate goes red. A future card that mounted
  the route unconditionally would otherwise expose an unauthenticated JSON-RPC surface on the app's
  own origin — including the desktop build. This test is worth keeping **whether or not desktop
  ever ships**, and does not depend on any decision in this report.

**Exit condition:** the packaged renderer cannot access Node or the filesystem, unexpected navigation is blocked, external destinations open safely, and Electron security warnings are clean. **[revised 08-26]** The MCP exposure test passes, and the chosen MCP option from
[Network MCP on the desktop](#network-mcp-on-the-desktop-unresolved) is implemented and tested.

### 5. Windows installer, identity, and signing

- Add product name, publisher, description, copyright, executable name, application ID, and version metadata.
- Produce a complete multi-resolution `.ico` asset and installer/uninstaller branding.
- Use Electron Forge's Squirrel.Windows maker to generate a user-level `Hybrid Command Center Setup.exe`, installed application executable, update package, and release metadata.
- Handle Squirrel install, update, first-run, and uninstall events before normal application startup.
- Create Start menu and optional desktop shortcuts with a stable Windows App User Model ID.
- Acquire an Authenticode signing route: Azure Trusted Signing if the publisher qualifies, or a suitable hardware/cloud-backed code-signing certificate.
- Keep all signing credentials outside the repository and expose them only to the protected release job.
- Test x64 first. Treat Windows on Arm as a separate supported artifact and validation target rather than assuming the x64 build is sufficient.

**Exit condition:** a clean Windows 10/11 user can install, launch, pin, update, and uninstall the signed application without Node.js, npm, a repository checkout, administrator rights, or a visible console window.

### 6. Release, update, and rollback pipeline

- Add a protected Windows release workflow that builds from a clean checkout, runs the existing gates, creates the installer, signs it, and records checksums and provenance.
- Publish through a selected channel: GitHub Releases for a public distribution, or protected static/private release storage for a private application.
- Add automatic update checks only after installer identity, signing, data migration, and rollback are proven.
- Download updates in the background, let the user defer restart, and never apply while a backup/restore/import is active.
- Keep application versioning aligned with the repository's current four-location release convention and changelog-fragment workflow.
- Before any schema-changing update, create or verify a database backup and retain the installer needed for rollback.
- Define rollback honestly: an older binary may not read a newer schema, so rollback may require restoring the pre-update database backup.

**Exit condition:** a staged release can upgrade the previous desktop version without data loss, and the documented rollback rehearsal succeeds on a clean Windows machine.

### 7. Testing, diagnostics, and documentation

- Keep the existing unit, integration, browser end-to-end, typecheck, lint, format, audit, build, and version gates.
- Add Electron main-process tests for paths, single instance, navigation policy, launch authorization, shutdown, and startup failure handling.
- Add a Windows packaged-app smoke test that installs or launches the built artifact against a temporary `userData` directory.
- Run one milestone-level real workflow through the installed app: create data, restart, verify persistence, back up, and exercise Drive with a mock provider.
- Verify upgrade and uninstall/reinstall scenarios separately from a fresh install.
- Capture logs without credentials, OAuth codes, tokens, database contents, or signing secrets; provide an “Open logs folder” support action.
- Replace terminal-based installation/startup/troubleshooting sections in the user manual with installer, first-run, backup, update, and recovery guidance while retaining developer commands in the README.

**Exit condition:** CI proves both source-level behavior and a real Windows artifact, and a non-developer can install, configure, operate, back up, update, and recover the application from the manual alone.

## Suggested card sequence

| Order | Card | Relative size | Dependency |
| --- | --- | --- | --- |
| 0 | **[added 08-26]** Record the cloud-track decision and the MCP decision | None (decision only) | Blocks everything |
| 1 | Electron runtime spike: packaged `node:sqlite`, TypeScript loading, and `argon2` proof | Small–Medium | 0 |
| 2 | Reusable server startup, desktop window, and shutdown lifecycle | Medium | 1 |
| 3 | Per-user paths, automatic migration, backup/restore UI, and legacy import | Large | 2 |
| 4 | Desktop OAuth, DPAPI-backed token protection, Picker, and external navigation | Large | 2; coordinates with 3 |
| 5 | Electron security hardening and security regression tests | Medium | 2 and 4 |
| 6 | Squirrel installer, branding, shortcuts, and signing | Medium | 3 and 5 |
| 7 | Packaged Windows E2E, upgrade/rollback, release workflow, and manuals | Large | 6 |
| 8 | Automatic updates | Medium | 7 and a settled release host |

**[revised 08-26]** Card 1 grew from "Small" to "Small–Medium": it now carries three independent
runtime proofs rather than one, and the TypeScript question may force a repository-wide build step.
Card 0 is not engineering work — it is the two decisions this revision surfaced, and neither can be
settled by the implementer.

Cards 3 and 4 may proceed in parallel after the desktop lifecycle contract is stable, but both touch token/data migration and need a deliberate integration review. Automatic updates should not be bundled into the first installer proof; they magnify any mistake in migrations, signing identity, or shutdown behavior.

The MCP regression test in workstream 4 is the one item here that should be **unbundled from this
report entirely** and filed on its own. It defends current `main` against a future mistake and costs
almost nothing, regardless of whether a desktop card is ever opened.

## Indicative effort

For one developer already familiar with this repository, a signed Windows-first production release is approximately **four to six focused engineering weeks**, excluding waiting time for OAuth-console changes, publisher verification, or code-signing procurement. A proof-of-concept window and unsigned installer may take only several days, but it would not meet the production acceptance criteria in this report.

The largest uncertainty is existing-workspace and encrypted-token migration, followed by signing/update infrastructure. Supporting macOS and Linux in the same release would add platform-specific credential storage, signing/notarization, installers, paths, and CI rather than being a free Electron output.

**[revised 08-26]** The four-to-six week figure still holds, for changed reasons. C52 removed the
Drive scope migration from workstream 3 (smaller); the TypeScript loading question and the MCP
decision were added (larger). These roughly cancel.

Two caveats the original estimate did not state:

- It assumes **desktop replaces or defers the cloud track**. If desktop becomes a *second supported
  target*, the estimate does not apply — two auth models, two OAuth client types, two MCP
  transports, two backup stories, and two release pipelines have to be maintained in parallel, and
  that is a standing cost rather than a one-time project.
- It excludes the cost of re-verifying this report again. It went stale in eight days once, and
  `main` is still moving.

## Decisions required before implementation

### Blocking — added by the 2026-08-26 revision

These two precede the list below. Neither is the implementer's to settle, and the original seven
decisions are moot until the first is answered.

- **Cloud track versus desktop.** Replace, run both, or defer — see
  [Relationship to the cloud track](#relationship-to-the-cloud-track). `docs/cloud-hosting.md` is
  currently a decided record that rules a desktop package out; nothing here proceeds until that is
  either amended or this report is shelved.
- **MCP on the desktop.** Drop it, spawn stdio as a utility process, or mount the network transport
  — see [Network MCP on the desktop](#network-mcp-on-the-desktop-unresolved). Option 2 is
  recommended. This changes workstreams 1, 4, and 7 and cannot be deferred to implementation.

### Original seven

1. **Distribution audience:** one owner, a private team, or public customers. This determines signing, release hosting, support, and update requirements.
2. **OAuth ownership:** the Google Cloud project and Desktop app client that will ship, including consent-screen publication and verification responsibilities.
3. **Publisher identity and signing budget:** legal publisher name and Authenticode route.
4. **Migration experience:** automatic discovery of a known prior install, or an explicit backup/database picker. Explicit import is safer and recommended.
5. **Update channel:** manual signed downloads for the first release, then GitHub/static-storage automatic updates after upgrade rehearsal is green.
6. **Supported Windows targets:** Windows 10/11 x64 only for the first release, or x64 plus Arm64.
7. **Integration configuration:** whether Google and publishing credentials are organization-managed defaults, user-entered settings, or optional features disabled until configured.

## Production acceptance criteria

- The installer and installed executable are signed and identify the expected publisher.
- A clean supported Windows machine installs and runs the application without Node.js, npm, Git, PowerShell, or a repository checkout.
- Double-click/Start-menu launch opens one application window and no console; a second launch focuses the first.
- The API binds only to loopback on a non-conflicting port and requires its launch-bound authorization value.
- The database, backups, logs, and secrets use documented per-user locations and survive normal updates and uninstall/reinstall.
- Fresh initialization and legacy import are both transaction-safe, tested, and recoverable from a verified backup.
- The renderer is sandboxed and isolated, has no Node access, loads no remote code, and cannot navigate to unapproved content.
- Google OAuth uses the system browser, PKCE, expiring single-use state, and a loopback callback; tokens remain encrypted at rest.
- All existing quality gates pass, plus packaged Windows smoke, persistence, install, upgrade, and rollback tests.
- The manual covers installation, first run, Drive setup, backup, restore, update, uninstall, diagnostics, and recovery without terminal commands.
- **[added 08-26]** `/api/mcp` is proven unreachable on the desktop's loopback origin, by a test, and
  the chosen MCP option is implemented and documented.
- **[added 08-26]** A pre-C52 workspace import routes the operator to a Drive reconnect rather than
  silently re-encrypting a full-scope token.

## Recommendation

**[revised 08-26]** The original recommendation was to approve a proof card first. That is no longer
the first step, because a prior question has been answered in the opposite direction since this
report was drafted.

**Settle the cloud-track question before approving any card.** `docs/cloud-hosting.md` is a decided
record that rules a desktop package out as the first shape, and C51–C55 and C113 have since built
against that decision through to a rehearsed cutover. Approving a desktop proof card today would
fund two divergent directions at once without anyone having chosen to. That is a product decision,
not an engineering one, and it is not this report's to make.

If the desktop direction is affirmed, then the original recommendation stands, with additions:
approve a Windows x64 Electron/Forge proof card constrained to runtime compatibility, reusable server
startup, loopback port assignment, one secure window, and clean shutdown. Do not call the proof a
desktop release and do not distribute its unsigned installer. The proof must now demonstrate
**`node:sqlite`, the TypeScript loading strategy, and `argon2`** inside the packaged Electron runtime
— all three, before workstream 2 opens — along with the production build, CRUD, backup, and
shutdown. If it does, proceed through the data/OAuth/security cards before signing and release
automation.

If the desktop direction is deferred or declined, one item should still be filed separately: the
`/api/mcp` loopback exposure test from workstream 4. It defends current `main` and is independent of
everything else here.

## External references

- [Electron process model and utility processes](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron application data paths](https://www.electronjs.org/docs/latest/api/app)
- [Electron OS-backed safe storage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron distribution overview](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
- [Electron Forge Squirrel.Windows installer](https://www.electronforge.io/config/makers/squirrel.windows)
- [Electron Forge Windows code signing](https://www.electronforge.io/guides/code-signing/code-signing-windows)
- [Electron application updates](https://www.electronjs.org/docs/latest/tutorial/updates)
- [Google OAuth for desktop applications](https://developers.google.com/identity/protocols/oauth2/native-app)

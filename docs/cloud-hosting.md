# Cloud Hosting — Decision Record

Status: **recommended, awaiting product sign-off. Not implemented.** Nothing in this app is
reachable off loopback by design. This document settles the architecture an implementation would
otherwise settle by accident, and it is the thing an Infra 2 implementation card is written
against — not a survey, and not a plan to change `HOST` and see what happens.

Card: C20 (#77). Resolves Infra 2 / Master Plan §6a / decision §5.6. Builds on the tested backup
and restore path from C10 (#66).

**`HOST` cannot expose the current server.** The default bind stays `127.0.0.1`, and the half of
the §5.1 bind gate that can be enforced without authentication now is: `server/config.ts` refuses
to start on anything but `127.0.0.1`, `::1`, or `localhost` (C31, #129). A non-loopback bind stays
forbidden until authentication from §5 is shipped and verified, at which point that check widens to
the rest of the checklist rather than being lifted.

---

## 1. The decision

**Ship a private single-instance remote deployment for one operator, with SQLite remaining
authoritative on that host, gated by a password session before any listen address leaves
loopback.** Multi-device access is a side effect of one HTTPS URL, not a sync product. Multi-user
collaboration, a hosted multi-tenant database, and a desktop package are explicitly not the first
cloud shape.

Seven things follow, and the rest of this document is those seven things in detail:

1. The access model is **single-user remote**. One operator, many devices, one workspace.
2. The source of truth is **SQLite on the private host**. Local remains a separate install, not a
   cache of the host and not a peer in a sync mesh.
3. The deployment shape is a **private single instance** behind HTTPS. A desktop package solves
   installation only and does not satisfy "lives in the cloud" on its own.
4. Authentication is a **single operator password** (argon2id) plus an **HttpOnly Secure session
   cookie**, with CSRF protection on every state-changing request, before the process may bind
   off loopback.
5. Drive OAuth gains a **production HTTPS redirect URI**; encrypted tokens stay on the host; Drive
   keeps working when the laptop is off because the host holds the refresh token.
6. The operator owns **backups and updates**; recurring hosting cost is a small always-on instance.
7. Migration and rollback reuse **C10's `db:backup` / `db:restore`**, with the local database kept
   until the host rehearsal passes.

---

## 2. Access model

**Recommendation: single-user remote access.**

The product already names its audience: one creative director, one local workspace, no
collaboration, portals, or permissions (`README.md`). "Lives in the cloud" for that product means
the same workspace is reachable from a phone or a second laptop without copying a `.db` file by
hand. That is single-user remote. Multi-device is free once there is one authenticated HTTPS URL;
it is not a separate sync product.

| Model | What it buys | What it costs this codebase |
| --- | --- | --- |
| Single-user remote | Reach the existing workspace from any device | Auth, HTTPS, hosted secrets, production OAuth redirect, ops |
| Multi-device sync | Same, plus offline edits on each device that converge later | Conflict rules, sync protocol, offline queue, a second source of truth — a different product |
| Multi-user collaboration | Several people in one workspace | Accounts, authorization, per-user Drive grants, audit, presence — a rewrite of every write path |

**Why not multi-user first.** Building multi-user on top of today's unauthenticated API means
inventing tenancy after the fact: every route assumes one workspace, Drive tokens are one
connection, Signal's schedule is one calendar, and branding is one sidebar. Shipping single-user
remote does not paint the multi-user corner — the session is one operator identity, and a later
multi-user card would replace that identity model rather than stretch it. Shipping multi-user
prematurely *would* paint a corner: every table would grow an owner column for a need that does
not exist yet.

**Cost of this choice.** One operator account, one session secret, no sharing links, no roles.
Collaborators keep using Drive sharing for files and stay out of the command center until a
future card deliberately opens that door.

**Revisit when** a second person needs write access to clients, projects, tasks, or Signal inside
this app rather than in Drive or a shared screen.

---

## 3. Source of truth

**Recommendation: SQLite on the private host is authoritative.**

Today one file — `data/command-center.db` — is the workspace. C10 made that file backupable and
restorable. The least-disruptive cloud shape keeps that file, moves it to the host, and leaves
the schema and the `node:sqlite` stack alone.

| Option | Verdict |
| --- | --- |
| Local SQLite stays authoritative, sync/backup layered on | Rejected for the first cloud release. Sync is the multi-device product from §2, not "lives in the cloud." Scheduled off-site backup of a local-only install is useful ops hygiene; it is not remote access. |
| Hosted SQLite authoritative (private instance) | **Chosen.** Same database, same migrations, same backup scripts, different machine. |
| Hosted Postgres (or similar) authoritative, local becomes a cache | Rejected for the first cloud release. Touches every repository, every migration, every test harness, and every C10 script. Worth a later card only if the private instance outgrows SQLite or multi-tenant tenancy arrives. |

**Cost of this choice.** Concurrent writers are still one process. Horizontal scale is not on the
table. The host must treat the database file the way the laptop does: scripted backup, no naked
copy of an open WAL database, encryption key kept beside the backup.

Local installs do not become caches of the host. A laptop that still runs `npm run dev` against
loopback is a separate workspace unless the operator restores a backup into it. That is deliberate:
two live writers against one logical workspace without a sync protocol is how data is lost.

---

## 4. Deployment shape

**Recommendation: private single instance behind HTTPS.**

| Shape | Verdict |
| --- | --- |
| Private single instance | **Chosen.** One VM or one PaaS service, one process, one SQLite file, one operator. Least disruptive path from today's architecture. |
| Managed multi-tenant SaaS | Rejected for now. Needs the multi-user model from §2, a hosted database from §3, billing, and isolation that this app has never modelled. |
| Native / desktop package | Rejected as the answer to "lives in the cloud." A desktop package solves *installation* (double-click, no Node toolchain). It does not put the workspace on a URL, does not keep Drive reachable when the machine is off, and does not satisfy remote access on its own. It remains a fine *parallel* track if packaging ever matters; it is not this card. |

**Concrete host shape.** One small always-on instance (a single Fly.io / Railway / Render service,
or a $5–12/mo VPS) running the existing Node server in production mode, with the built client
served from the same origin, TLS terminated at the platform edge or a reverse proxy, and the
SQLite file on a persistent volume. No container cluster, no read replicas, no CDN in front of
the API.

**Cost of this choice.** The operator pays a small monthly bill and owns deploys. The app stays
one process. Failover is "restore the latest backup onto a new instance," not automatic HA.

---

## 5. Authentication

**Recommendation: one operator password (argon2id) + signed HttpOnly Secure session cookie + CSRF
on mutations. HTTPS required before any non-loopback bind. Secrets only in the host secret store.**

There is no authentication today. Every API route trusts the browser that can reach it. That is
acceptable on `127.0.0.1` and nowhere else. "Add auth later" is not an answer; without a named
scheme, hosting is just publishing an open database.

### 5.1 What ships

1. **Operator password.** A single password, hashed with argon2id, stored in the host environment
   or in a local settings row written only by a bootstrap CLI — never in the repo, never returned
   to the browser. There is no self-registration and no second account.
2. **Session cookie.** After a successful login, the server sets an HttpOnly, Secure,
   `SameSite=Lax` cookie carrying a signed session (random id server-side, or an iron-sealed
   payload with expiry). Idle and absolute timeouts are required; logging out clears the cookie
   and the server record.
3. **CSRF.** Every state-changing request (`POST` / `PATCH` / `PUT` / `DELETE`) requires a CSRF
   token bound to the session (double-submit cookie or a response header the client echoes).
   Cookie auth without CSRF is not shipping.
4. **Origin lock.** Production CORS / `APP_ORIGIN` is the public HTTPS origin only. The Drive
   OAuth callback remains same-site under that origin.
5. **Bind gate.** The process refuses to listen on anything other than loopback unless (a) a
   session secret and operator password hash are configured, (b) `APP_ORIGIN` is `https:`, and
   (c) a production flag acknowledges TLS termination. Changing `HOST` alone must continue to be
   treated as a foot-gun in docs and in code. **Shipped, in its fail-closed form** (C31, #129):
   none of (a)–(c) can be satisfied yet, so `server/config.ts` refuses every non-loopback `HOST`
   at boot and names the variable. Implementing this item means replacing that constant with the
   three conditions above — the refusal is the default and stays the default.
6. **Hosted secrets.** `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, the session signing
   secret, and the operator password hash live in the platform secret store or a root-only env
   file outside the app tree. They are never written to `integration_events`, never logged, and
   never shipped in the client bundle.

### 5.2 Why not Google sign-in for the app

Drive already uses Google OAuth for Drive scopes. Reusing Google as the *app* login is attractive
— one identity — and wrong for the first release: it couples "who may open the command center" to
"which Google account holds the files," complicates the existing single-use OAuth `state`
callback, and still needs sessions, CSRF, and HTTPS. A password session keeps those concerns
apart. A later card may add passkeys or an allowlisted Google OIDC login; it would replace the
password verifier, not the session and CSRF machinery.

### 5.3 Cost of this choice

One login screen, one bootstrap path to set the password, session middleware on every API route
(including Drive connect), CSRF on the client fetch layer, and a production boot check that fails
closed. Local `npm run dev` on loopback stays passwordless so day-to-day development does not
inherit the hosted threat model.

---

## 6. Drive OAuth continuity

**Recommendation: add a production HTTPS redirect URI; keep encrypted tokens on the host; Drive
must keep working when the laptop is off.**

### 6.1 Redirect URIs

Today the authorized redirect is `http://localhost:8787/api/drive/oauth/callback`. A hosted
deploy adds a second authorized URI on the same OAuth client:

```text
https://<public-host>/api/drive/oauth/callback
```

`GOOGLE_REDIRECT_URI` on the host is that HTTPS value, byte-for-byte. The localhost URI stays on
the client for local development. The existing single-use `state` handling in
`server/drive/oauth.ts` does not change shape; only the configured redirect and `APP_ORIGIN` do.

After cutover the operator reconnects Drive once on the host (or restores a database whose
ciphertext was encrypted with the same `GOOGLE_TOKEN_ENCRYPTION_KEY`). Old localhost-issued
refresh tokens remain valid at Google; what changes is where the callback can land.

### 6.2 Laptop off

Yes — Drive access from the hosted app must work when the operator's machine is off. That is the
point of moving the process: Sync to Folder, Files browse, and token refresh run on the host,
which holds the encrypted refresh token in SQLite. The laptop is not in the path.

### 6.3 Drive-token threat model

| Threat | Mitigation |
| --- | --- |
| Browser XSS reading tokens | Tokens never leave the server; client never sees them (`AGENTS.md`). |
| Attacker with the SQLite file | Ciphertext only without `GOOGLE_TOKEN_ENCRYPTION_KEY`; key lives in the secret store, not in the database, and is backed up separately (C10 / user manual §10). |
| Attacker with the running host | Full Drive grant for the connected account. Mitigate with HTTPS, the §5 session, minimal existing Drive scope, platform firewall / private deployment, and a one-click disconnect + Google revoke path that already exists in spirit via Settings reconnect. |
| Stolen backup | Same as stolen SQLite file — useless without the encryption key. Keep key and backup in different places. |
| Open redirect / callback replay | Existing single-use `state` delete-before-exchange; production callback is HTTPS-only. |
| Token used after operator leaves the product | Disconnect in Settings; revoke the app in Google Account permissions. |

**Cost of this choice.** One extra redirect URI to maintain, one reconnect (or keyed restore) at
cutover, and an explicit acceptance that host compromise equals Drive compromise for that Google
account — which is already true of any server that stores a refresh token.

---

## 7. Operational cost

**Recommendation: budget roughly $5–15/month for a small always-on instance plus object-storage
backup; the operator owns backups and updates.**

| Item | Who owns it | Notes |
| --- | --- | --- |
| Compute (VM / PaaS) | Operator | One small instance; expect about $5–15/month at 2026 hobby pricing. Confirm against the chosen provider before the implementation card closes. |
| Persistent volume for SQLite | Operator | Included or a few dollars more; the database must survive redeploys. |
| Off-site backups | Operator | Scheduled `npm run db:backup` (or the same API it wraps) copied to object storage or another machine. C10's rehearsal stays the confidence check. |
| TLS certificate | Platform / reverse proxy | Usually free (Let's Encrypt or platform edge). |
| Domain name | Operator | Optional but recommended; otherwise the platform hostname is the `APP_ORIGIN`. |
| Google OAuth client + Drive | Operator / Google | Unchanged account; still the operator's Google project. |
| Application updates | Operator | Deploy from git; run migrations; rehearse backup first on a copy. |
| Monitoring | Operator | Platform health check on `/` or a tiny readiness route; disk alert on the volume. |

There is no separate ops team. Once the data is not "a file on one machine," the operator is the
team: if backups are not running, there are no backups.

**Cost of this choice.** A standing monthly bill and a calendar reminder for updates. In exchange,
the workspace is reachable without the laptop and without inventing a sync protocol.

---

## 8. Data migration and rollback

**Recommendation: move with C10's scripted backup/restore; keep the local database until the host
rehearsal passes; roll back by pointing at the untouched local copy or restoring the previous host
snapshot.**

### 8.1 Forward path

1. On the laptop, with the app stopped or using the online backup API: `npm run db:backup`.
2. Copy the timestamped snapshot and the `GOOGLE_TOKEN_ENCRYPTION_KEY` by separate channels to
   the host (backup in object storage or `scp`; key in the secret store).
3. On the host, configure secrets and the production HTTPS origin; deploy the app against an empty
   volume.
4. `npm run db:restore -- <snapshot> --force` then `npm run db:migrate`.
5. `npm run db:backup:rehearse` against a *copy* on the host — same confidence bar C10 established.
6. Start the host app; log in with the operator password; confirm clients/projects/tasks; reconnect
   or verify Drive; spot-check Files and Sync to Folder.
7. Only then stop treating the laptop copy as live. Keep it as a cold spare.

No production data is moved by this decision record. The steps above are the implementation card's
cutover checklist, not something to run from this PR.

### 8.2 Rollback

| Failure | Rollback |
| --- | --- |
| Host restore fails integrity / foreign-key checks | Do not cut over. Fix the snapshot; laptop remains authoritative. |
| Host is up but Drive tokens will not decrypt | Wrong or missing `GOOGLE_TOKEN_ENCRYPTION_KEY`. Restore key from the separate backup; if lost, reconnect Drive (folder IDs survive; ciphertext is replaced). |
| Host is up but the workspace looks wrong | `npm run db:restore` the previous host safety snapshot C10 leaves beside the backup, or fall back to the laptop database that was never deleted. |
| Operator wants off the cloud | `npm run db:backup` on the host → restore onto the laptop → set `HOST` back to loopback → remove the production redirect URI when ready. |

Rollback never requires a schema down-migration for the first cutover: the host and the laptop
run the same version. If a later cloud-only migration appears, it ships with its own rehearsal
and its own rollback note; it is out of scope here.

### 8.3 Cost of this choice

One rehearsal window and the discipline to keep the local file until the host is proven. No ETL,
no dual-write window, no "local is a cache" half-state.

---

## 9. What this does not decide

- Which PaaS or VPS brand to use — any host that offers HTTPS, a persistent volume, and secret
  storage fits §4 and §7; pick at implementation time against current pricing.
- Passkeys, magic links, or Google OIDC as a login upgrade — future cards may replace the
  password verifier without revisiting sessions, CSRF, or the bind gate.
- Packaging a desktop installer — orthogonal; does not meet the cloud requirement alone (§4).
- Multi-user collaboration — deferred until product sign-off revisits §2.
- Moving off SQLite — deferred until the private instance proves too small or tenancy arrives (§3).

---

## 10. Sign-off

This record is the recommendation. Sign-off is a product decision on this document (issue #77 /
the pull request that lands it), not a follow-up research card.

**Sign off means:** the seven recommendations above are the shape Infra 2 will implement, and no
implementation card for cloud hosting opens until this status line reads **decided, not
implemented.**

**Reject or amend means:** edit this document in the same branch or a follow-up docs card before
any code binds off loopback.

Until then, local-first on `127.0.0.1` remains the only supported deployment.

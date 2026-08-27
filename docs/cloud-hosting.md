# Cloud Hosting — Decision Record

Status: **decided (C50 / #176). Runtime contract settled on AWS; C51–C54 shipped; C55 adds the
cutover rehearsal runbook.** Nothing in this app is reachable off loopback by design until an operator
completes production cutover. Sections 1–8 are the product decision (C20 / #77). Section 11 is the
production implementation contract C51–C55 are written against. Section 12 names the inert AWS account
resources staged with C50. The step-by-step rehearsal checklist is
[`docs/cloud-cutover-rehearsal.md`](cloud-cutover-rehearsal.md).

**`HOST` cannot expose the current server.** The default bind stays `127.0.0.1`, and the half of
the §5.1 bind gate that can be enforced without authentication now is: `server/config.ts` refuses
to start on anything but `127.0.0.1`, `::1`, or `localhost` (C31, #129). Production keeps that
loopback bind behind a reverse proxy (§11); authentication from §5 and the §11 checklist are what
make the public HTTPS origin safe — changing `HOST` alone remains forbidden as a foot-gun.

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

**Concrete host shape.** **AWS** — one always-on EC2 instance running the existing Node server in
production mode, with the built client served from the same origin, TLS terminated at a reverse
proxy on that host, and the SQLite file on a dedicated EBS volume. Exact runtime fields are §11.
No container cluster, no read replicas, no CDN in front of the API, no PaaS multi-tenant runtime.

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
5. **Bind gate.** Production keeps `HOST` on loopback behind Caddy (§11); the process still
   refuses every non-loopback `HOST` as a foot-gun. The public origin is safe only when the full
   checklist is configured: (a) session secret and operator password hash, (b) `APP_ORIGIN` is
   `https:`, (c) `PRODUCTION_TLS_TERMINATED=true`, and (d) `TRUSTED_PROXY_HOPS` set explicitly
   (production value `1` per §11). **Shipped, in its fail-closed form** (C31, #129): non-loopback
   `HOST` is refused today. C51 widens enforcement so that checklist also gates authenticated
   access on the loopback-behind-proxy shape — changing `HOST` alone must never be the way to
   "turn hosting on."
6. **Hosted secrets.** `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, the session signing
   secret, and the operator password hash live in AWS SSM Parameter Store under `/hcc/production/`
   (§11.4), not in the repo, not in the backup bucket, and not in the client bundle. They are
   never written to `integration_events` and never logged.

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
the client for local development. Boot validation accepts only those shapes on the fixed path
`/api/drive/oauth/callback` (no query or hash). Pending OAuth state lives in
`oauth_pending_states` (C52), not a single settings row.

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
| Browser XSS reading tokens | Tokens never leave the server; client never sees stored refresh/access tokens (`AGENTS.md`). Picker uses a separate short-lived GIS token. |
| Attacker with the SQLite file | Ciphertext only without `GOOGLE_TOKEN_ENCRYPTION_KEY`; key lives in the secret store, not in the database, and is backed up separately (C10 / user manual §10). |
| Attacker with the running host | `drive.file` grant for files the app created or the operator selected in Picker. Mitigate with HTTPS, the §5 session, platform firewall / private deployment, and disconnect + Google revoke. |
| Stolen backup | Same as stolen SQLite file — useless without the encryption key. Keep key and backup in different places. |
| Open redirect / callback replay | Single-use, expiring, session-bound pending states deleted before exchange; production callback is HTTPS-only on a fixed path. |
| Token used after operator leaves the product | Disconnect in Settings; revoke the app in Google Account permissions. |

**Cost of this choice.** One extra redirect URI to maintain, Picker API key + project number, one
reconnect (with Google revoke) at cutover from any prior full-Drive grant, and an explicit
acceptance that host compromise equals Drive compromise for selected content — which is already
true of any server that stores a refresh token.

---

## 7. Operational cost

**Recommendation: budget roughly $5–15/month for a small always-on instance plus object-storage
backup; the operator owns backups and updates.**

| Item | Who owns it | Notes |
| --- | --- | --- |
| Compute (AWS EC2) | Operator | One small instance; budget ceiling **$20/month** (§11). Typical mix is ~$5–15 for compute + EBS + S3 + light transfer at 2026 pricing. |
| Persistent volume for SQLite | Operator | Dedicated gp3 EBS volume (§11); the database must survive stop/start and instance replacement that reattaches the volume. |
| Off-site backups | Operator | Scheduled `npm run db:backup` (or the same API it wraps) copied to the dedicated S3 bucket (§11 / C54). C10's rehearsal stays the confidence check. |
| TLS certificate | Operator / Let's Encrypt | Terminated by Caddy on the EC2 host (§11). |
| Domain name | Operator | Existing **Wix DNS** (not Route 53). `APP_ORIGIN` is the HTTPS hostname that CNAME points at the instance. |
| Google OAuth client + Drive | Operator / Google | Unchanged account; still the operator's Google project. Production redirect URI shape in §11. |
| Application updates | Operator | Deploy from git; run migrations; rehearse backup first on a copy. |
| Monitoring | Operator | `/api/health` for liveness/readiness; CloudWatch disk alarm → SNS (§11). |

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
cutover checklist, not something to run from this PR. The runnable operator checklist, failure table,
and monitoring confirmation live in [`cloud-cutover-rehearsal.md`](cloud-cutover-rehearsal.md) (C55).

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

- Passkeys, magic links, or Google OIDC as a login upgrade — future cards may replace the
  password verifier without revisiting sessions, CSRF, or the bind gate.
- Packaging a desktop installer — orthogonal; does not meet the cloud requirement alone (§4).
- Multi-user collaboration — deferred until product sign-off revisits §2.
- Moving off SQLite — deferred until the private instance proves too small or tenancy arrives (§3).
- The exact public hostname string — the operator picks one under the existing Wix DNS zone; §11
  settles the **shape** of `APP_ORIGIN` and the Google redirect URI, not a marketing domain.

Provider and runtime shape **are** decided: AWS EC2 + Caddy + EBS + SSM + S3, in §11.

---

## 10. Sign-off

C20 (#77) adopted the seven recommendations in §§1–8. **C50 (#176) decides the provider and
settles the production runtime contract in §11**, and stages the inert AWS account prerequisites
in §12. Implementation cards C51–C55 open against this document; they do not re-litigate AWS vs
another host.

**Amend means:** edit this document in the same branch or a follow-up docs card before C51–C55
assume a different proxy hop count, secret name, volume path, or backup destination.

Local-first on `127.0.0.1` remains the only **running** deployment until C53 attaches compute.
The resources in §12 are inert on purpose.

---

## 11. AWS production runtime contract (C50 / #176)

This section is the implementation contract. C51 (auth), C53 (runtime package), C54 (hosted
backups), and C55 (cutover rehearsal) consume these rows; they do not invent parallel names.

Verified against `server/config.ts`, `server/index.ts`, `server/shutdown.ts`, `server/backup.ts`,
`GET /api/health` in `server/app.ts`, `package.json` `engines.node` (`>=24`), and the production
start path `npm start` → `node --experimental-strip-types server/index.ts --production` (serves
`dist/client` and the API from one process).

### 11.1 Service and runtime shape

| Field | Contract |
| --- | --- |
| Provider | **Amazon Web Services** |
| Region | **`us-east-1`** (N. Virginia). All §12 resources and the future EC2 host live here. |
| Compute | One **EC2** instance, Amazon Linux 2023, architecture **arm64** (`t4g.small` class; C53 may pick the exact size within the §11.10 budget). |
| Process | Exactly **one** Node process managed by **systemd** (`hybrid-command-center.service`). `Restart=on-failure`. `Type=simple`. |
| Node | **Node.js 24** (matches `engines.node`: `>=24`). Install from NodeSource or the OS package C53 pins; do not run under a second major. |
| App start | `npm ci && npm run build && npm start` after migrations. Production flag is `--production` / `NODE_ENV=production` as `server/index.ts` already understands. |
| Same origin | Built client (`dist/client` static + SPA fallback) and API share **one** public HTTPS origin. No separate API hostname. |
| Listen address | **`HOST=127.0.0.1`**, **`PORT=8787`**. The process never binds a public interface. Caddy on the same host terminates TLS and proxies to loopback. |
| One writer | systemd starts one unit; a second `npm start` against the same `DATABASE_PATH` is an operator error and is out of contract. SQLite remains single-writer. |

### 11.2 TLS and trusted proxy hops

| Field | Contract |
| --- | --- |
| TLS termination | **Caddy** on the EC2 host, listening on `:443` (and `:80` only for ACME). Certificates via Let's Encrypt. |
| Upstream | `reverse_proxy 127.0.0.1:8787` with `X-Forwarded-For` and `X-Forwarded-Proto` set by Caddy. |
| Trusted hops | **`TRUSTED_PROXY_HOPS=1`**. Exactly one reverse-proxy hop (Caddy on the host). The app peels one rightmost address from `X-Forwarded-For` for login rate limits and session metadata. |
| Spoofing | With hops `1`, a client-supplied left-hand `X-Forwarded-For` chain is not trusted beyond that single peel. Hops `0` would ignore the header entirely; that value is wrong for this shape because Caddy always forwards. |
| Production acknowledgement | **`PRODUCTION_TLS_TERMINATED=true`** is required before the public origin is considered configured. It means "Caddy (or equivalent) terminates HTTPS in front of loopback," not "the Node process speaks TLS." |
| Auth vs loopback | Because `HOST` stays loopback, **operator authentication is enforced when the §5.1 / §11 production checklist is complete**, not by moving `HOST` off loopback. Local `npm run dev` without that checklist stays passwordless. C51 implements that distinction; this contract forbids "bind `0.0.0.0` to turn auth on." |

### 11.3 Persistent volume and database path

| Field | Contract |
| --- | --- |
| Volume | Dedicated **gp3 EBS** volume, encrypted, attached at boot. Not the root volume. |
| Mount | **`/var/lib/hybrid-command-center`** (ext4). Survives instance stop/start and can be reattached to a replacement instance. |
| `DATABASE_PATH` | **`/var/lib/hybrid-command-center/command-center.db`** |
| Local backups dir | Default beside the database: `/var/lib/hybrid-command-center/backups/` (C10 layout). On-box copies are not the off-site store. |
| Redeploy | Replacing the AMI / re-running deploy must **not** recreate this mount. Root-disk ephemerality is assumed; data-disk durability is required. |

### 11.4 Secret store (names only — no values in git)

Secrets live in **AWS Systems Manager Parameter Store** under `/hcc/production/`. The EC2 instance
role may read that path; humans write values. Application environment variable names match the
parameter leaf names.

| Parameter name | Env var | Owner | Notes |
| --- | --- | --- | --- |
| `/hcc/production/SESSION_SECRET` | `SESSION_SECRET` | Operator (C51) | ≥32 characters. Session HMAC / cookie binding. |
| `/hcc/production/OPERATOR_PASSWORD_HASH` | `OPERATOR_PASSWORD_HASH` | Operator (C51) | Argon2id hash from the bootstrap CLI — never the password. |
| `/hcc/production/GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_ID` | Operator | OAuth client id. |
| `/hcc/production/GOOGLE_CLIENT_SECRET` | `GOOGLE_CLIENT_SECRET` | Operator | OAuth client secret. |
| `/hcc/production/GOOGLE_TOKEN_ENCRYPTION_KEY` | `GOOGLE_TOKEN_ENCRYPTION_KEY` | Operator | ≥32 characters. **Never** stored in the backup bucket or beside a snapshot. |
| `/hcc/production/POST_BRIDGE_API_KEY` | `POST_BRIDGE_API_KEY` | Operator | Optional publishing. |
| `/hcc/production/BUFFER_API_KEY` | `BUFFER_API_KEY` | Operator | Optional Buffer reads. |

Non-secret production env that is **not** in Parameter Store (set on the unit / drop-in):

| Env var | Production value |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `8787` |
| `DATABASE_PATH` | `/var/lib/hybrid-command-center/command-center.db` |
| `APP_ORIGIN` | `https://<public-host>` (§11.5) |
| `GOOGLE_REDIRECT_URI` | `https://<public-host>/api/drive/oauth/callback` |
| `PRODUCTION_TLS_TERMINATED` | `true` |
| `TRUSTED_PROXY_HOPS` | `1` |
| `LOG_LEVEL` | `info` (or `warn`) |

SSM parameters staged by §12 hold the sentinel **`UNSET`** (SSM rejects a blank string). That
sentinel is not a secret. C53 boot must refuse required secrets still set to `UNSET`.

### 11.5 Public origin and Google redirect shape

| Field | Contract |
| --- | --- |
| DNS | **Existing Wix DNS** — no Route 53 hosted zone. Operator creates a CNAME (or A) for the chosen hostname to the instance Elastic IP once C53 launches it. |
| `APP_ORIGIN` | `https://<public-host>` — scheme `https`, host only, **no path, no trailing slash, no port**. |
| Google redirect | `https://<public-host>/api/drive/oauth/callback` — same host as `APP_ORIGIN`, path fixed. Added on the existing Google OAuth client at cutover (out of scope for this card). |
| CORS | Production CORS allows only that `APP_ORIGIN`. |

### 11.6 Off-site backup destination (C54)

| Field | Contract |
| --- | --- |
| Store | One private **S3** bucket (name in §12). |
| Encryption | SSE-S3 (AES-256) at rest; bucket policy denies non-TLS. |
| Access | Public access blocked. Only the production instance role and the operator's admin principal may write/list. |
| Versioning | Enabled. Lifecycle expires noncurrent versions after **90 days**; aborts incomplete multipart uploads after **7 days**. |
| Key separation | `GOOGLE_TOKEN_ENCRYPTION_KEY` is **not** stored in this bucket and is **not** included in backup objects. Key recovery is Parameter Store (and the operator's private offline copy), never "download the latest `.db`." |
| Transfer | C54 schedules `db:backup` then uploads the snapshot object; it never copies a live WAL database with `aws s3 cp` against the open file. |

### 11.7 Health, disk, logs, alerts

| Field | Contract |
| --- | --- |
| Liveness / readiness | **`GET /api/health`** — existing handler runs `SELECT 1` and returns `{ ok: true }` or **503**. Caddy and any future ELB health check use this path. No separate `/ready` until a card proves a need. |
| Disk | CloudWatch alarm on EBS volume free space (warn below **20%**, critical below **10%**) → SNS topic in §12. |
| Deploy / app logs | journald for the systemd unit; optional CloudWatch Logs agent in C53. Logs must keep the existing redaction rules (no cookies, secrets, or token material). |
| Alert destination | **SNS topic** `hcc-production-alerts` → operator email subscription (§12). |
| Restart | systemd `Restart=on-failure`; SIGINT/SIGTERM use `server/shutdown.ts` (stop HTTP, then close SQLite once). |

### 11.8 Recovery objectives and retention

| Field | Contract |
| --- | --- |
| Backup schedule (C54) | At least **daily** off-site snapshot to S3; keep the last **14** successful off-site objects without deleting the last known-good. |
| RPO | **≤ 24 hours** (daily off-site). Tighter cadence is allowed; this is the maximum gap the contract promises. |
| RTO | **≤ 4 hours** to restore onto a replacement instance from the latest good S3 snapshot + Parameter Store key, excluding Google/DNS propagation delays outside the app. |
| Rehearsal | C10 `db:backup:rehearse` (or C54's scheduled equivalent) on a disposable copy — never against the live file as the rehearsal target. |

### 11.9 Network (documented for C53 — nothing attached in C50)

| Field | Contract |
| --- | --- |
| VPC | Default VPC in `us-east-1`, or a single public subnet VPC C53 creates if the default is unsuitable. No private-only host without SSM egress for this first release. |
| Subnet | One public subnet with an **Elastic IP** on the instance so DNS stays stable across stop/start. |
| Security group `hcc-production-sg` (create/attach in C53) | Inbound: **443/tcp** from `0.0.0.0/0` (and `::/0` if IPv6). Inbound **22/tcp** **denied** — admin via **SSM Session Manager** only. Inbound **80/tcp** from the same sources only if Caddy needs HTTP-01 (otherwise closed). Outbound: HTTPS to SSM, S3, Let's Encrypt, Google APIs, and the publish providers the operator configured. |
| SSH | Not used. The instance role includes `AmazonSSMManagedInstanceCore`. |

### 11.10 Expected monthly cost ceiling

| Item | Planning figure (USD / month) |
| --- | --- |
| EC2 `t4g.small` on-demand (approx.) | ~6–10 |
| gp3 EBS ~20–40 GB | ~2–4 |
| S3 backups + versioning | <1 |
| SNS / CloudWatch / SSM | <1 |
| Data transfer (light operator use) | ~1–3 |
| **Budget alert ceiling** | **$20** |

The AWS Budget `hcc-production-monthly` (§12) alerts at **80%** and **100%** of that ceiling.

### 11.11 What C50 deliberately leaves unbuilt

- No EC2 instance, no attached instance profile, no security-group association to a running ENI.
- No secret **values** in Parameter Store (sentinel `UNSET` only).
- No Google OAuth redirect registered on the live client.
- No production data, no Drive traffic from this card.
- No change to the loopback bind gate in application code in this card.

---

## 12. Staged AWS account prerequisites (C50)

All of the following are **inert**: none is attached to compute, and the workspace stays unreachable
off loopback. Template: [`docs/aws/c50-account-prerequisites.yaml`](aws/c50-account-prerequisites.yaml).
Stack name: **`hcc-c50-account-prerequisites`**. Region: **`us-east-1`**. Account:
**`233171357361`**. Stack status after this card: **`CREATE_COMPLETE`**.

| Resource | Name / identity | State after C50 |
| --- | --- | --- |
| IAM role | `hcc-production-ec2` (`arn:aws:iam::233171357361:role/hcc-production-ec2`) | Exists; **not** attached to any instance (0 EC2 reservations use the profile). |
| Instance profile | `hcc-production-ec2` | Exists; unused until C53. |
| S3 bucket | `hcc-production-backups-233171357361` | Versioned, SSE-S3, public access blocked, lifecycle as §11.6; **zero objects**. |
| SSM parameters | `/hcc/production/SESSION_SECRET`, `OPERATOR_PASSWORD_HASH`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `POST_BRIDGE_API_KEY`, `BUFFER_API_KEY` | Names reserved; value **`UNSET`**. |
| SNS topic | `hcc-production-alerts` (`arn:aws:sns:us-east-1:233171357361:hcc-production-alerts`) | Exists; operator email `gholmesdesigns@gmail.com` subscribed (confirm the SNS opt-in mail). |
| AWS Budget | `hcc-production-monthly` | Ceiling **$20**; email at 80% and 100% actual. |
| Security group / VPC | Documented in §11.9 only | **Not** created here — attaching a SG without an instance invites drift; C53 creates `hcc-production-sg` with the instance. |
| Route 53 | — | **Not** created; Wix DNS remains authoritative (§11.5). |

Re-apply (owner only, never CI), if the stack must be updated:

```bash
aws cloudformation deploy \
  --stack-name hcc-c50-account-prerequisites \
  --template-file docs/aws/c50-account-prerequisites.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides OperatorAlertEmail=gholmesdesigns@gmail.com \
  --region us-east-1
```

**Console verification (acceptance):** IAM role has no instance attachments; S3 bucket object
count is 0; each SSM parameter exists with value `UNSET`; SNS topic exists; budget exists; no
EC2 instance was started by this stack.

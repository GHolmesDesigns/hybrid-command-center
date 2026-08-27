# Cloud cutover rehearsal and production cutover

This runbook is the **operator-owned** sequence for moving the workspace to the AWS host,
rehearsing rollback, and — only after a successful disposable staging pass — cutting over
production. It implements [`cloud-hosting.md` §8](cloud-hosting.md).

| Track | Card | Infrastructure |
| --- | --- | --- |
| **Staging (rehearsal)** | C55 / #181 | Disposable EC2 + EBS; no Wix DNS; no production Google redirect |
| **Production cutover** | C115 / #363 | Production host; public HTTPS origin; live data and credentials |

**Agents and CI** use mock Drive, disposable databases, and non-production hosts only. Every step
that moves production data, credentials, DNS, or grants is marked **Operator stop** below.

---

## Prerequisites

Confirm before starting the matching column:

| Prerequisite | Staging | Production |
| --- | --- | --- |
| Cards on `main` | C51–C54 | C51–C55, **C114** (#362) |
| Host | Disposable staging EC2 + EBS — not the production hostname | Production EC2 + EBS per [`deploy/aws/`](../deploy/aws/README.md) and [`cloud-hosting.md` §11](cloud-hosting.md) |
| Artifact | `npm run build:production-artifact` → `dist/production` (no secrets/DB) | Same build that includes C114 auth enforcement |
| Local rehearsal | `npm run db:backup:rehearse` on a **copy** of the laptop DB you intend to migrate | Same, immediately before freeze/snapshot |
| Staging pass | — | Disposable staging checklist below has passed |

Reuse [`deploy/aws/README.md`](../deploy/aws/README.md) with a staging hostname and sentinel SSM
values on staging only. Production loads real SSM secrets (no `UNSET`).

---

## Human-only stop conditions

Stop and hand off to the operator before any action that:

- moves production data;
- creates or changes provider/OAuth credentials;
- revokes a Google grant;
- rotates or enters an encryption/session key;
- changes DNS or the production public origin;
- freezes the live workspace or authorizes final cutover.

The same list is encoded in `server/domain/cutover-rehearsal.ts` for tests and tooling.

---

## Staging vs production checklist

Use the **Staging** column for C55 rehearsal. Use the **Production** column only after staging
passes and the operator explicitly continues (C115).

| Step | Staging | Production |
| --- | --- | --- |
| 1. Freeze or snapshot source **Operator stop** | Stop local app **or** `npm run db:backup`; verify with `db:backup:rehearse` on a copy; keep laptop DB | Same |
| 2. Transfer snapshot and key separately **Operator stop** | Copy `.db` to staging storage/`scp`; encryption key via separate channel (staging SSM) | Same channels to **production** object storage and `/hcc/production/*` SSM |
| 3. Deploy on empty volume **Operator stop** | Attach staging volume; install `dist/production`; staging `runtime.env` (no production DNS/redirect) | Attach production volume; install artifact; load SSM secrets with **no `UNSET`**: `SESSION_SECRET`, `OPERATOR_PASSWORD_HASH` (`auth:bootstrap`), Drive keys, encryption key |
| 4. Origin and TLS **Operator stop** | Staging HTTPS host only; do **not** change Wix DNS or production Google redirect | Set `APP_ORIGIN` and `GOOGLE_REDIRECT_URI` to `https://<public-host>`; add that redirect on the Google OAuth client; point Wix DNS (CNAME/A) at the Elastic IP; Caddy terminates TLS → `127.0.0.1:8787` |
| 5. Restore and migrate **Operator stop** | `npm run db:restore -- <snapshot> --force` then `npm run db:migrate` | Same on the production volume |
| 6. Backup/restore rehearsal on host | `cutover:rehearse` / `db:backup:rehearse` / off-site rehearsal on disposable paths | Confirm timers and monitoring (table below); optional disposable subdir rehearsal before traffic |
| 7. Authenticated HTTPS smoke **Operator stop** | `/api/health`; login/CSRF/limits/logout; `TRUSTED_PROXY_HOPS=1`, `PRODUCTION_TLS_TERMINATED=true`, `HOST=127.0.0.1`; clients/projects/tasks/Calendar/Signal/Files/import/publish preflight | Same, **and** login from a **second device** against the public origin; C114 checklist must enforce auth on loopback-behind-Caddy |
| 8. Drive reconnect (`drive.file`) **Operator stop** | Disconnect if needed; revoke in Google Account; reconnect; Picker; tokens decrypt | Same on production origin; revoke any obsolete broad grant |
| 9. Declare authoritative **Operator stop** | Staging is never the live workspace | Only after every production row passes: stop treating the laptop as live; keep it as a cold spare until a fresh hosted backup exists; then name `https://<public-host>` in README, USER_MANUAL, and hosting docs |

Example public host shape (operator-chosen under the Wix zone): `https://hcc.gholmesdesigns.com`.
Do not treat that string as live until step 9 completes.

### Restore commands (both columns)

```bash
npm run db:restore -- /path/to/snapshot.db --force
npm run db:migrate
```

### Disposable rehearsal CLI (staging; optional on production before traffic)

```bash
npm run cutover:rehearse -- --plan
npm run cutover:rehearse -- --disposable-dir /var/lib/hybrid-command-center/rehearsal
npm run cutover:rehearse -- --disposable-dir /var/lib/hybrid-command-center/rehearsal --rollback-rehearsal --stopped
```

Or use the existing C10/C54 paths:

```bash
npm run db:backup:rehearse
npm run db:backup:offsite:rehearse
```

---

## Rollback rehearsal (hosted writes)

If the host has accepted writes and rollback is needed:

1. **Freeze writes** on the host (stop the systemd unit).
2. Take and verify a **fresh hosted backup** — `npm run db:backup` and off-site upload.
3. Restore that snapshot on a replacement volume or instance.
4. The **pre-cutover laptop copy is not a current rollback source** once hosted writes exist.

Verify on disposable infrastructure:

```bash
npm run cutover:rehearse -- --disposable-dir ./rehearsal --rollback-rehearsal --stopped
```

Restored databases revoke all operator sessions; every browser must sign in again.

---

## Leaving the cloud

1. `npm run db:backup` on the host.
2. Restore onto the laptop with `npm run db:restore -- <snapshot> --force`.
3. Return `HOST` to loopback and use local `npm run dev` or `npm start` on `127.0.0.1`.
4. Remove the production redirect URI from the Google OAuth client when ready.

---

## Failure decision table

| Situation | Action | Abort cutover? |
| --- | --- | --- |
| Backup or restore fails integrity / foreign-key checks | Fix the snapshot; keep the current authoritative copy. | Yes |
| Drive tokens will not decrypt | Restore `GOOGLE_TOKEN_ENCRYPTION_KEY`; if lost, reconnect Drive (folder IDs survive). | Yes |
| `REHEARSAL-FAILED.txt` or off-site rehearsal marker shows FAILURE | Inspect the marker, fix backup path, rerun rehearsal on a copy. | Yes |
| Auth, CSRF, proxy trust, or bind-gate preflight fails | Fix secrets and `APP_ORIGIN`; never widen `HOST`. | Yes |
| Counts or Drive references differ after restore rehearsal | Rerun `db:backup:rehearse` and compare the report. | Yes |
| Backup age exceeds RPO (24h) or disk alarm critical (<10% free) | Run off-site backup, confirm rehearsal, free disk. | Yes |
| Hosted rollback needed | Freeze writes; restore latest **hosted** snapshot only. | Yes |
| Operator wants off the cloud | Fresh hosted backup → restore locally → loopback. | No |

---

## Monitoring confirmation

Before declaring staging ready (and again before production cutover):

| Check | Where |
| --- | --- |
| `/api/health` liveness | `curl -fsS https://<host>/api/health` |
| systemd app unit active | `systemctl is-active hybrid-command-center` |
| Single-writer lock | Second `flock --nonblock` on writer lock must fail |
| Off-site backup timer | `systemctl list-timers hcc-offsite-backup.timer` |
| Weekly restore rehearsal | `systemctl list-timers hcc-backup-rehearsal.timer` |
| Backup health / disk | `systemctl list-timers hcc-backup-health.timer`; CloudWatch `disk_used_percent` |
| Rehearsal markers | No `REHEARSAL-FAILED.txt` beside backups; off-site `rehearsal.json` not FAILURE |
| SNS alerts | Confirm subscription on `hcc-production-alerts` |

See [`offsite-backup-operations.md`](offsite-backup-operations.md) for S3 restore and timer details.

---

## Automated verification (CI / agents)

The Playwright spec `e2e/cloud-cutover-rehearsal.spec.ts` rehearses login, authenticated workspace
use, Drive mock reconnect, restart persistence, backup, frozen-write rollback, and post-restore
verification on a throwaway database. It never contacts production infrastructure.

Unit coverage: `server/domain/cutover-rehearsal.test.ts`, existing backup and auth tests.

Live production cutover evidence is **owner-run and not committed**.

---

## Related documents

- [`cloud-hosting.md`](cloud-hosting.md) — product decision and §11 runtime contract
- [`deploy/aws/README.md`](../deploy/aws/README.md) — systemd, Caddy, staging verification
- [`offsite-backup-operations.md`](offsite-backup-operations.md) — S3 backup and recovery
- [`USER_MANUAL.md`](../USER_MANUAL.md) — operator-facing backup and Drive guidance

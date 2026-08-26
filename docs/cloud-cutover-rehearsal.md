# Cloud cutover rehearsal (C55 / #181)

This runbook is the **operator-owned** sequence for moving the workspace to the AWS host,
rehearsing rollback, and returning to loopback. It implements [`cloud-hosting.md` §8](cloud-hosting.md)
on disposable staging infrastructure.

**Agents and CI** use mock Drive, disposable databases, and non-production hosts only. Every step
that moves production data, credentials, DNS, or grants is marked **Operator stop** below.

---

## Prerequisites

Confirm before starting:

- [ ] Cards **C51** (operator auth), **C52** (`drive.file` + Picker), **C53** (runtime package), and
      **C54** (off-site backups) are merged on `main`.
- [ ] A **disposable** staging EC2 instance and EBS volume — not the production hostname, not Wix DNS
      changes. Reuse [`deploy/aws/README.md`](../deploy/aws/README.md) with a staging hostname and
      sentinel SSM values replaced on the staging host only.
- [ ] `npm run build:production-artifact` produces `dist/production` with no secrets or database.
- [ ] Local `npm run db:backup:rehearse` passes against the laptop copy you intend to migrate.

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

## Forward migration checklist

### 1. Freeze or snapshot the source **Operator stop**

- Stop the local app **or** take the supported online backup: `npm run db:backup`.
- Verify the snapshot with `npm run db:backup:rehearse` on a **copy** (never the live file as the
  rehearsal target).
- Keep the laptop database until the host rehearsal passes.

### 2. Transfer snapshot and key separately **Operator stop**

- Copy the timestamped `.db` snapshot to staging object storage or `scp`.
- Copy `GOOGLE_TOKEN_ENCRYPTION_KEY` through a **separate** channel (SSM Parameter Store on the host,
  never beside the backup object).

### 3. Deploy on an empty volume **Operator stop**

- Attach the encrypted gp3 volume at `/var/lib/hybrid-command-center`.
- Install from `dist/production`, configure `runtime.env` from SSM (no `UNSET` sentinels).
- Do **not** register the production Google redirect or change Wix DNS in this rehearsal.

### 4. Restore and migrate **Operator stop**

```bash
npm run db:restore -- /path/to/snapshot.db --force
npm run db:migrate
```

### 5. Rehearse backup/restore on staging

On the disposable host (application stopped for restore steps):

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

### 6. Start authenticated HTTPS and smoke-check **Operator stop**

- [ ] `/api/health` returns `{ ok: true }` through Caddy on HTTPS.
- [ ] Operator login, CSRF on mutations, brute-force limits, and session logout work.
- [ ] `TRUSTED_PROXY_HOPS=1`, `PRODUCTION_TLS_TERMINATED=true`, `HOST=127.0.0.1`.
- [ ] Clients, projects, tasks, Calendar, Signal, Files browse, import preview, publishing preflight.
- [ ] Sync to Folder provisions against mock or connected Drive on staging.

### 7. Drive reconnect with `drive.file` **Operator stop**

- [ ] Disconnect in Settings if migrating from an old full-Drive grant.
- [ ] Revoke the app in [Google Account permissions](https://myaccount.google.com/permissions).
- [ ] Reconnect on the host; OAuth requests only `drive.file`; Picker selects the root folder.
- [ ] Confirm encrypted tokens decrypt with the restored encryption key.

### 8. Declare authoritative **Operator stop**

Only after every item above passes: stop treating the laptop copy as live. Keep it as a cold spare
until a fresh hosted backup exists.

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
| `/api/health` liveness | `curl -fsS https://<staging-host>/api/health` |
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

---

## Related documents

- [`cloud-hosting.md`](cloud-hosting.md) — product decision and §11 runtime contract
- [`deploy/aws/README.md`](../deploy/aws/README.md) — systemd, Caddy, staging verification
- [`offsite-backup-operations.md`](offsite-backup-operations.md) — S3 backup and recovery
- [`USER_MANUAL.md`](../USER_MANUAL.md) — operator-facing backup and Drive guidance

# Off-site backup and recovery operations

The production host takes an online SQLite snapshot before it transfers anything. It uploads only
that completed file to the private, versioned S3 bucket with SSE-S3 and a SHA-256 checksum. The
Drive-token encryption key remains in Parameter Store and the operator's separate offline recovery
channel; it must never be placed in the bucket, runtime environment file backup, or notification.

## Host configuration

Install AWS CLI v2 and copy the six `hcc-*backup*.service` / `.timer` units from `deploy/aws` to
`/etc/systemd/system`. The instance role needs only list/get/put/delete objects under `snapshots/`
in `hcc-production-backups-233171357361` and publish to `hcc-production-alerts`. Set these non-secret
values in the root-owned `0600` `/etc/hybrid-command-center/runtime.env`:

```text
HCC_BACKUP_BUCKET=hcc-production-backups-233171357361
HCC_ALERT_TOPIC_ARN=<SNS topic ARN>
HCC_BACKUP_DIR=/var/lib/hybrid-command-center/backups
HCC_BACKUP_STATE_DIR=/var/lib/hybrid-command-center/backup-state
```

Enable the three timers. Daily backup keeps the newest 14 successful objects and never deletes the
last known-good object. Weekly rehearsal downloads the newest snapshot into a disposable directory,
checks SQLite integrity and foreign keys, migrates a disposable copy, and compares expected record
counts, Drive references, and encrypted-token presence. Hourly health checks alert on a failed or
older-than-26-hours backup, a failed rehearsal, and volume free space below 20% (critical below 10%).
Failures also leave root-private JSON markers, so monitoring survives a process exit.

## Restore runbook

1. Stop `hybrid-command-center.service`; never restore over a running database.
2. Select the newest object whose scheduled rehearsal passed and download it with checksum mode
   enabled to a disposable path. Retrieve `GOOGLE_TOKEN_ENCRYPTION_KEY` separately from Parameter
   Store or the offline recovery copy.
3. Run `npm run db:backup:rehearse -- --database <downloaded.db> --dir <disposable-dir>`. Do not
   continue unless integrity, foreign keys, counts, Drive references, and encrypted-token presence pass.
4. Run `npm run db:restore -- <downloaded.db> --force`. Restore revokes every live operator session;
   the operator must sign in again after traffic resumes.
5. Run `npm run db:migrate`, start the service, and verify `GET /api/health` before restoring traffic.
6. Confirm Drive tokens decrypt. If the separately stored key is unavailable, reconnect Drive; do
   not weaken encryption or copy a key into S3.

For a transfer, rehearsal, or disk alert, inspect the named systemd unit and the private marker.
Notifications intentionally contain only an operation and bounded reason—never credentials, tokens,
workspace rows, provider responses, or database content.

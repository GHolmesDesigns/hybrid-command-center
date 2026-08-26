# AWS production runtime

This directory is the deployable runtime contract for C53. It creates no AWS resources by itself.
The supported shape is one arm64 Amazon Linux 2023 EC2 instance, Caddy on the same host, one Node
process, and one encrypted gp3 EBS volume mounted at `/var/lib/hybrid-command-center`.

## Deploy sequence

1. Attach the existing `hcc-production-ec2` instance profile and a dedicated encrypted EBS volume.
   Mount the volume at `/var/lib/hybrid-command-center`; never place the database on the root disk.
2. Install Node.js 24, Caddy, and `util-linux` (for `flock`). Create the system user/group `hcc`.
3. Copy `dist/production` to a versioned directory under `/opt/hybrid-command-center/`, run
   `npm ci --omit=dev`, then atomically update the `current` symlink.
4. Build `/etc/hybrid-command-center/runtime.env` from `runtime.env.example`: load secrets from
   SSM `/hcc/production/*`, replace every `UNSET`, and set the exact public origin. The environment
   file must be root-owned mode `0600`; do not print it.
5. Replace `command-center.example.com` in `Caddyfile` with the exact public hostname, install the
   service and Caddy files, and validate with `caddy validate --config /etc/caddy/Caddyfile`. Run
   `systemctl daemon-reload`, then enable and start Caddy and the app service.
6. Install the CloudWatch agent with `cloudwatch-agent.json` and create alarms for volume
   `disk_used_percent` above 80% (warning) and 90% (critical), both targeting
   `hcc-production-alerts`. The CloudFormation template also installs the EC2 status alarm.

`docs/aws/c53-production-runtime.yaml` is the reviewed infrastructure manifest. Supply a pinned
arm64 Amazon Linux 2023 AMI, the selected public subnet/VPC/AZ, and deploy it in `us-east-1`. It
creates the single instance, HTTPS-only security group (port 80 only for ACME), Elastic IP,
encrypted retained/snapshotted data volume, attachment, and instance-status alarm. It deliberately
does not contain secret values, DNS changes, application bytes, or production data.

The unit deliberately migrates before application traffic, takes a non-blocking writer lock, and
sends SIGTERM so HTTP drains before SQLite closes. A second unit/process using the same lock refuses
to start. `RequiresMountsFor` prevents a missing data mount from silently creating a database on the
root disk. The application preflight refuses incomplete auth, TLS/proxy mismatch, a non-HTTPS origin,
an inconsistent OAuth redirect, relative storage, missing Drive configuration, and SSM `UNSET`
sentinels before SQLite opens or the HTTP listener starts.

## Verification without production traffic

- Run `npm run build:production-artifact` and inspect `dist/production` for the server, client,
  shared modules, lockfiles, documentation, and these manifests. No `.env`, database, or secret is
  copied.
- On a disposable staging host and volume, install/start the unit, request `/api/health`, create a
  local record, restart the service, and verify that record remains.
- Stop the database or make its path unreadable and verify `/api/health` returns 503.
- Attempt a second `flock --nonblock /run/hybrid-command-center.writer.lock ...`; it must fail.
- Send SIGTERM and verify the unit stops cleanly once. Exercise phone and desktop widths against the
  same HTTPS origin with the existing Playwright suite.

Do not register the production Google redirect, populate real credentials, restore production data,
or change Wix DNS as part of this PR. Those are cutover actions owned by the operator; see
[`docs/cloud-cutover-rehearsal.md`](../../docs/cloud-cutover-rehearsal.md) for the disposable staging
rehearsal and production cutover checklist (C55).
# Backup timers

Copy and enable `hcc-offsite-backup.timer`, `hcc-backup-rehearsal.timer`, and
`hcc-backup-health.timer` with their matching services. See
`docs/offsite-backup-operations.md` for IAM scope, configuration, monitoring, and the restore
runbook. The services use the instance role; never place AWS credentials in `runtime.env`.

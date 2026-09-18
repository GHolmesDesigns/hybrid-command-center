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
   SSM `/hcc/production/*`, replace every `UNSET`, set the exact public origin, and set
   `PUBLISH_TIMEZONE` to the deployment's explicit IANA zone (production currently uses
   `America/New_York`). This host file is the systemd service's configuration source; a `.env` in a
   developer checkout is not read by the deployed service. The environment file must be root-owned
   mode `0600`; do not print it.
5. Replace `command-center.example.com` in `Caddyfile` with the exact public hostname, install the
   service and Caddy files, and validate with `caddy validate --config /etc/caddy/Caddyfile`. Run
   `systemctl daemon-reload`, then enable and start Caddy and the app service. After changing
   `runtime.env`, restart `hybrid-command-center.service` and verify `/api/health`; configuration is
   read when the process starts.
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
or change Wix DNS as part of a runtime packaging change. Those are cutover actions owned by the
operator; see [`docs/cloud-cutover-rehearsal.md`](../../docs/cloud-cutover-rehearsal.md) for the
disposable staging column (C55) and the production cutover column (C115).

## WebSocket live updates (C236)

Caddy v2 `reverse_proxy` forwards WebSocket upgrades without extra directives. Caddy does not impose
a short idle timeout on upgraded connections by default; upstream TCP keepalive and the
application's own ping interval keep long-lived Agent Hub sockets from going stale behind the proxy.

The Node server sends WebSocket **ping** control frames every **30 seconds**
(`AGENT_HUB_WS_SERVER_PING_INTERVAL_MS` in `shared/agent-hub-live.ts`). Choose an interval shorter
than any intermediary idle timeout you introduce later (load balancers often use 60–120 seconds).

After deploy, confirm a WebSocket connect through Caddy succeeds:

```bash
# Replace the host and session cookie after signing in.
curl -i -N \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Origin: https://command-center.example.com' \
  -H 'Cookie: hcc_session=…' \
  'https://command-center.example.com/api/agent-hub/ws'
```

Expect `101 Switching Protocols` when the session cookie is valid and the Origin matches
`APP_ORIGIN` exactly.

**Production verification (C241, 18 Sep 2026):** WebSocket connects through Caddy; wake frames
trigger debounced HTTP reread; reconnect after disconnect succeeds. The C219 SSE fallback route
was removed after this verification.

# Backup timers

Copy and enable `hcc-offsite-backup.timer`, `hcc-backup-rehearsal.timer`, and
`hcc-backup-health.timer` with their matching services. See
`docs/offsite-backup-operations.md` for IAM scope, configuration, monitoring, and the restore
runbook. The services use the instance role; never place AWS credentials in `runtime.env`.

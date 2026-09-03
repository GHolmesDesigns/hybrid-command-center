# Drive-write security and operating-cost review

**Review date:** 2026-09-03
**Scope:** C162 / #454 as implemented by #499 and #500
**Decision:** Conditionally acceptable for the current low-volume, operator-approved
boundary. It is not acceptable as an indefinite retention policy for upload payloads.

## Decision

The current capability is proportionate to its stated purpose: it permits only project-scoped
folder creation and bounded uploads, requires an explicitly granted agent scope, creates a
pending request rather than contacting Drive, and requires an operator decision before the
provider is called. The grant remains disabled by default and Files remains read-only.

The qualification is material: an upload request stores its base64 payload inside `plan_json`,
and the row is not removed or compacted after approval, denial, or failure. The 10 MiB per-upload
limit bounds one request, but there is no pending-request count, age, or total-payload bound.
Therefore the present design is safe enough for a deliberately enabled, trusted operator
installation only while request volume is low and the database is access-controlled. Payload
retention must be fixed before this capability is treated as a general multi-agent service.

No production Drive call, quota claim, or provider-side cost claim is made by this review.

## Assets and trust boundaries

| Asset | Boundary and protection | Residual concern |
| --- | --- | --- |
| OAuth refresh/access tokens | Encrypted server-side; never returned to the browser or written to the integration log | A database and encryption-key compromise can expose the grant; revocation is an operator procedure |
| Drive folders and files | `drive.file` OAuth scope; write targets must be the project folder or recorded `drive_steps` folder ID | A connected account can still create or upload within the provider's interpretation of that grant |
| Upload bytes | Agent sends base64 over an authenticated MCP request; server decodes and bounds it at 10 MiB; provider receives bytes only after approval | Bytes remain in SQLite in `drive_write_requests.plan_json` after the request is decided |
| Pending request and plan hash | Agent-labeled row, unique `(agent_label, client_request_id)`, exact plan hash and confirmation text | Rows and payloads have no expiry or purge lifecycle |
| Operator decision | Browser operator route changes `PENDING` to `EXECUTING` atomically before the provider call | A process failure during `EXECUTING` needs operational investigation; it cannot be approved a second time |
| Audit trail | Append-only integration events; credentials and payload bytes are not placed in summaries; event retention is capped at 200 rows | The audit row proves an attempt and outcome, not provider-side deletion or external retention |

The trust boundary is intentionally split: an agent may request, but cannot execute; the operator
route owns approval; `DriveWriteProvider` owns the provider call; and `DriveProvider`/Files has no
write method. This review does not recommend widening any of those boundaries.

## Threat-model review

### Project scoping

`previewDriveFolderCreate` and `previewDriveUpload` resolve the requested folder ID against the
project's root folder and recorded step folders. Names are display data, not authorization data.
An unowned folder is rejected before a request is persisted. This limits accidental or malicious
cross-project writes, subject to the correctness of the local project-to-folder records and the
connected Google account.

### OAuth scope and blast radius

The connection requests `https://www.googleapis.com/auth/drive.file`, not full Drive access.
Existing folders become available only through the explicit Picker selection flow. This is a
meaningful reduction in blast radius, but it is not a proof that a compromised token is harmless:
the selected root and app-created items remain writable. Disconnecting locally does not revoke
Google's grant; the documented Google Account revocation step is required after suspected
exposure.

### Replay, stale plans, and duplicate requests

The SHA-256 plan hash covers the complete write plan, including target, name, MIME type, size, and
upload content. A changed plan cannot reuse an old confirmation. A duplicate client request ID is
replayed only within the same agent label, and a different agent gets a separate row. This prevents
cross-agent idempotency collisions but deliberately does not deduplicate identical work requested
with different IDs.

### Approval races and provider failures

Approval claims a row with `WHERE status='PENDING'` before calling Drive. Concurrent approvals
therefore result in at most one provider call. Denial uses the same pending-state guard. Provider
failure is recorded as `FAILED` with a bounded, redacted error, while the request payload remains
available in the row. The local state cannot establish whether a provider call that succeeded
before a process crash was externally duplicated; recovery and reconciliation are outside this
capability.

### Audit redaction

Integration events record the request ID, confirmation summary, entity IDs returned by Drive, and
bounded failure text. The upload content is not included in the summary or error field, and
`redactSecrets` handles the free-text external error path. The audit log is therefore suitable
for local diagnosis, but it is not a content-retention or provider-reconciliation record.

## Cost model and bounds

### Local storage

The decoded upload is capped at 10 MiB (`DRIVE_UPLOAD_MAX_BYTES`). Base64 expands that payload
to at most 13,981,016 ASCII characters, before JSON, SQLite record overhead, and page/WAL effects.
The request table has no maximum row count and the payload is retained for every terminal state.
Consequently:

- one request is bounded, but total retained upload bytes are not;
- 100 maximum-size requests are roughly 1.30 GiB of base64 text before SQLite overhead;
- 1,000 maximum-size requests are roughly 13.0 GiB before SQLite overhead;
- the 6-per-rolling-minute integration write limiter bounds one authenticated HTTP session, and
  the persisted HTTP limiter registry adds network-side limits, but neither is a durable storage
  quota and neither limits requests over time or across credentials;
- the 200-row integration-event retention limit bounds the audit table, not
  `drive_write_requests`.

These are upper-bound calculations, not observed production measurements. SQLite free pages,
WAL checkpoints, backups, and filesystem allocation can make disk use differ from the payload
estimate.

### Provider requests and retry cost

A folder creation or upload produces one provider write attempt through the write provider.
Google provider calls retry up to three times for HTTP 429 and 5xx responses, so a single logical
operation can consume up to four provider attempts. The application does not claim a Google quota
unit count because the vendor response and quota accounting were not measured here. Repeated
agent requests with new client IDs and repeated operator approvals after a provider-side
uncertainty can create additional external work; the stale-plan and concurrency protections do
not solve that ambiguity.

### Operator workload

Every request requires a person to inspect an exact action and target. Denied and failed requests
remain visible, which supports investigation but increases list and review noise. There is no
approval-latency SLA, queue age alert, bulk approval, or automatic expiry. The current default-off
grant and bounded operation vocabulary keep the workload deliberately small; they do not provide
an ongoing service-level bound.

## Abuse cases and mitigations

| Abuse case | Current impact | Current mitigation | Required disposition |
| --- | --- | --- | --- |
| Agent submits a folder outside its project | Unauthorized folder creation if it reached Drive | Folder ID allowlist from project records; exact plan | Accept |
| Agent submits a maximum upload repeatedly | Local disk growth and operator queue growth; provider work only after approval | 10 MiB item cap, authenticated scope, per-session/network write limits, human approval | Follow-up: durable retention and volume policy |
| Agent submits the same request repeatedly | Duplicate pending rows and potentially duplicate approved files | Same-agent client-request idempotency only | Follow-up: expose queue volume/age and define operator policy; do not silently dedupe across agents |
| Two operators approve simultaneously | At most one Drive call; loser receives already-decided error | Atomic pending-to-executing claim | Accept |
| Plan target or content changes after preview | Stale approval could write unintended data | Hash covers complete plan | Accept |
| Provider times out after possibly creating a file | Retry or re-approval can duplicate an external file | Provider retry only for selected statuses; no external idempotency proof | Follow-up: document reconciliation/incident procedure before higher volume |
| Database or backup is copied | Upload bytes and encrypted token ciphertext are exposed to the compromise boundary | No credentials in logs; token encryption; database access controls are deployment responsibility | Follow-up: purge payloads and review backup handling |
| Error contains a secret | Secret could enter local audit data | Redaction and bounded error field | Accept with tests retained |

## Required follow-up

The required implementation card is [#516](https://github.com/GHolmesDesigns/hybrid-command-center/issues/516),
which depends on #501. It will:

1. expire or explicitly purge `PENDING` requests after a documented age;
2. remove `contentBase64` from terminal request rows after the provider attempt, while retaining
   non-sensitive metadata, outcome, timestamps, and confirmation evidence;
3. define behavior for abandoned `EXECUTING` rows and provider-uncertain failures before allowing
   retry;
4. add a durable total pending-payload/count limit and operator-visible queue age/size metrics;
5. test that purge removes payload bytes from the database and backups created afterward while
   preserving the audit and decision record.

The payload should be removed rather than merely encrypted: SQLite and its backups remain the
primary local exposure surface, and encryption would add key-management complexity without
reducing the need for expiry and volume limits. The provider must receive the bytes only during
the confirmed attempt; after that, the local record needs only the metadata required for audit
and recovery. Until this card lands, keep `drive:write-request` disabled by default and enable it
only for a known operator-controlled installation.

## Evidence and limits of evidence

Reviewed:

- merged #499 and #500 implementation and tests;
- `server/drive/write.ts`, `server/drive/agent-write.ts`, `server/drive/google.ts`,
  `server/drive/oauth.ts`, `server/mcp/integration-tools.ts`, `server/mcp/http.ts`,
  `server/mcp/stdio.ts`, `server/db.ts`, and `shared/integration-log.ts`;
- the focused Drive write, agent approval, OAuth, MCP, and HTTP tests;
- the documented Files and Agent Drive boundaries in `AGENTS.md`, `README.md`, and `USER_MANUAL.md`.

The tests prove local validation, scoping, hash rejection, idempotency, approval races, failure
handling, redaction, and mock-provider behavior. They cannot prove Google OAuth enforcement,
provider quota/cost, network retry semantics under every response, external file retention, disk
growth under sustained load, or the security of a particular deployment and backup system. No
production Drive or real credential was used.

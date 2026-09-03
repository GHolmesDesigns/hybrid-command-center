# Drive-write security and operating-cost review

**Review date:** 2026-09-03
**Scope:** C162 / #454 as implemented by #499 and #500, with #516 follow-up
**Decision:** Acceptable for the current low-volume, operator-approved boundary, with the
implemented retention and volume controls treated as part of that boundary.

## Decision

The current capability is proportionate to its stated purpose: it permits only project-scoped
folder creation and bounded uploads, requires an explicitly granted agent scope, creates a
pending request rather than contacting Drive, and requires an operator decision before the
provider is called. The grant remains disabled by default and Files remains read-only.

The follow-up is now implemented. Pending requests expire after 24 hours; the global pending queue
is capped at 20 requests and 50 MiB of decoded upload bytes; execution has a one-hour lease; and
terminal rows retain metadata and decision evidence without retaining upload content. Provider
uncertainty is terminal and non-retryable until an operator reconciles the external result. These
controls make the exposure and operator workload bounded, but this remains an explicitly granted,
operator-approved capability, not an unbounded general multi-agent upload service.

No production Drive call, quota claim, or provider-side cost claim is made by this review.

## Assets and trust boundaries

| Asset | Boundary and protection | Residual concern |
| --- | --- | --- |
| OAuth refresh/access tokens | Encrypted server-side; never returned to the browser or written to the integration log | A database and encryption-key compromise can expose the grant; revocation is an operator procedure |
| Drive folders and files | `drive.file` OAuth scope; write targets must be the project folder or recorded `drive_steps` folder ID | A connected account can still create or upload within the provider's interpretation of that grant |
| Upload bytes | Agent sends base64 over an authenticated MCP request; server decodes and bounds it at 10 MiB; provider receives bytes only after approval | Pending payloads remain in SQLite until expiry or decision; a live database and its backups are still sensitive |
| Pending request and plan hash | Agent-labeled row, unique `(agent_label, client_request_id)`, exact plan hash and confirmation text | Global pending queue is bounded at 20 requests and 50 MiB of decoded upload bytes; age is bounded at 24 hours |
| Operator decision | Browser operator route changes `PENDING` to `EXECUTING` atomically before the provider call | A process failure during `EXECUTING` needs operational investigation; it cannot be approved a second time |
| Audit trail | Append-only integration events; credentials and payload bytes are not placed in summaries; event retention is capped at 200 rows | The audit row proves an attempt and outcome, not provider-side deletion or external retention; terminal request metadata remains locally |

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
failure is recorded as `FAILED` with a bounded, redacted error. Network-like failures, and an
execution lease that expires after one hour, are recorded as `PROVIDER_UNCERTAIN`; that state is
non-retryable. The operator must inspect Drive and reconcile the external result before taking any
further action. A successful provider call followed by a process crash can remain ambiguous, but
the local workflow does not silently repeat it.

### Audit redaction

Integration events record the request ID, confirmation summary, entity IDs returned by Drive, and
bounded failure text. The upload content is not included in the summary or error field, and
`redactSecrets` handles the free-text external error path. The audit log is therefore suitable
for local diagnosis, but it is not a content-retention or provider-reconciliation record.

## Cost model and bounds

### Local storage

The decoded upload is capped at 10 MiB (`DRIVE_UPLOAD_MAX_BYTES`). Base64 expands that payload
to at most 13,981,016 ASCII characters, before JSON, SQLite record overhead, and page/WAL effects.
The pending queue is capped at 20 requests and 50 MiB of decoded upload bytes, and terminal
request rows are compacted to metadata. Consequently:

- one pending request is bounded at 10 MiB decoded (about 13,981,016 base64 characters);
- pending upload bytes are capped globally at 50 MiB decoded, across no more than 20 requests;
- completed, denied, failed, expired, and provider-uncertain rows do not retain `contentBase64`;
- expiry is evaluated when requests are created, listed, summarized, or decided; it is not a
  background timer, so an idle database may contain an old pending row until the next queue
  operation;
- the 6-per-rolling-minute integration write limiter bounds one authenticated HTTP session, and
  the persisted HTTP limiter registry adds network-side limits, but neither is a durable storage
  quota and neither limits requests over time or across credentials;
- the 200-row integration-event retention limit bounds the audit table; request metadata and
  terminal outcomes have their own lifecycle and are not deleted by that audit retention.

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
remain visible as metadata, which supports investigation without retaining payloads. The operator
card reports pending count, pending bytes, oldest pending age, and counts of expired and
provider-uncertain rows. There is no bulk approval or automatic provider reconciliation:
uncertainty requires an operator to inspect Drive before any new request is considered.

## Abuse cases and mitigations

| Abuse case | Current impact | Current mitigation | Required disposition |
| --- | --- | --- | --- |
| Agent submits a folder outside its project | Unauthorized folder creation if it reached Drive | Folder ID allowlist from project records; exact plan | Accept |
| Agent submits a maximum upload repeatedly | Bounded pending disk and queue growth; provider work only after approval | 10 MiB item cap, 20-request/50 MiB global pending limits, 24-hour expiry, authenticated scope, per-session/network write limits, human approval | Accept with operator monitoring |
| Agent submits the same request repeatedly | Duplicate pending rows and potentially duplicate approved files | Same-agent client-request idempotency only | Follow-up: expose queue volume/age and define operator policy; do not silently dedupe across agents |
| Two operators approve simultaneously | At most one Drive call; loser receives already-decided error | Atomic pending-to-executing claim | Accept |
| Plan target or content changes after preview | Stale approval could write unintended data | Hash covers complete plan | Accept |
| Provider times out after possibly creating a file | A blind retry can duplicate an external file | `PROVIDER_UNCERTAIN` is non-retryable; inspect Drive and reconcile before any new request | Accept with operator reconciliation |
| Database or backup is copied | Pending upload bytes and encrypted token ciphertext are exposed to the compromise boundary; terminal payloads are not | Pending expiry and limits; terminal payload purge; no credentials in logs; token encryption; database and backup access controls remain deployment responsibilities | Accept with backup review |
| Error contains a secret | Secret could enter local audit data | Redaction and bounded error field | Accept with tests retained |

## Follow-up status

Issue [#516](https://github.com/GHolmesDesigns/hybrid-command-center/issues/516) is implemented.
The request lifecycle now expires pending rows after 24 hours, caps the global pending queue at
20 requests and 50 MiB decoded upload bytes, leases execution for one hour, purges
`contentBase64` from terminal rows, and records provider uncertainty as a non-retryable state.
The operator queue exposes pending count, pending bytes, oldest age, expired count, and uncertain
count. Reconciliation remains an operator procedure: inspect Drive before submitting a new request
after `PROVIDER_UNCERTAIN`, and record the outcome outside the request row if local incident
tracking is needed.

The payload should be removed rather than merely encrypted: SQLite and its backups remain the
primary local exposure surface, and encryption would add key-management complexity without
replacing expiry or volume limits. Backups made before a row was compacted can still contain its
upload bytes; backup retention and access controls therefore remain part of the deployment's
security boundary. The application's backup process does not retroactively scrub old snapshots.
Keep `drive:write-request` disabled by default unless a known operator-controlled installation
needs it.

## Evidence and limits of evidence

Reviewed:

- merged #499 and #500 implementation and tests, plus the #516 retention and queue-control
  implementation and tests;
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

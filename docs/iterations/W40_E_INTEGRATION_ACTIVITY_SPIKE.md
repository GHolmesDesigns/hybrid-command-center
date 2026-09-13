# W40-E — Integration activity spike (C225 / #634)

Reviewed: 2026-09-13  
Branch: `chore/634-integration-activity-spike`  
Plan: `docs/iterations/WAVE_40_OPERATOR_WORKFLOW_UI.md` § W40-E, Q8–Q9

## Executive summary

The append-only `integration_events` log is already the operator-facing audit trail for every
integration write and refresh. The browser reads it through `GET /api/integrations/activity`;
agents read the same rows through MCP `integration_list_activity`. **Import** already renders the
full list beside import receipts, including a visible 200-row retention note. **Health** shows
liveness and readiness only — no activity list yet.

**Q8 decision: Option 1 — one reusable read-only panel in Import and Health.**  
**Q9 finding: 200 rows is sufficient; pagination is not required.**  
**Follow-on: file W40-E2** to extract the panel and mount it under Health / Operations.

Raw request debug logs stay off-limits per `docs/debug-logging.md`.

---

## Existing surfaces

| Surface | Role | Notes |
| --- | --- | --- |
| `docs/debug-logging.md` | Server `LOG_LEVEL` diagnostic | Explicitly no raw log panel |
| `server/integration-log.ts` | Append-only write + read | `redactSecrets` on `error`; 200-row retention on every write |
| `GET /api/integrations/activity` | Browser read | `source`, `correlationId`, `limit` filters; max 200 |
| `client/src/components/ImportView.tsx` | Operator UI | Full activity list + per-receipt correlation |
| `server/mcp/integration-tools.ts` | Agent read | `integration_list_activity` — same `listIntegrationEvents` |
| `client/src/components/HealthView.tsx` | Application health | Liveness/readiness cards only |

---

## Producer inventory

Every production `recordIntegrationEvent` call site, the fields it sets, and when it runs.

| Module | Source | Operation(s) | When | Fields written |
| --- | --- | --- | --- | --- |
| `server/import.ts` | `campaign-playbook` | `playbook.import` | Playbook commit (same transaction as receipt) | `summary`, `entities` (created clients/projects/tasks), `correlationId` = receipt id, `error` on REJECTED/FAILED |
| `server/signal/import.ts` | `signal-import` | `signal.import` | Signal workbook commit (same transaction as receipt) | `summary`, `entities` (created posts), `correlationId` = receipt id |
| `server/drive/service.ts` | `google-drive` | `drive.sync` | Manual Drive sync (Settings or MCP) | `summary`; `entities` (clients + projects synced) on success/partial; `error` not used (failures per-row stay in API response, not log) |
| `server/drive/write.ts` | `google-drive` | `drive.create-folder`, `drive.upload-file` | Confirmed human Drive write | `summary`, `entities` (folder or file), `error` on failure |
| `server/drive/agent-write.ts` | `google-drive` | `drive.agent-write-request` | Agent Drive write request lifecycle | `summary`, `correlationId` = request id, `error` on failure |
| `server/publish/service.ts` | `signal-campaign` | `signal.publish`, `signal.publish-now`, `signal.reconcile`, `signal.provider-update`, `signal.provider-cancel` | Publish submit, Buffer/Post Bridge answers, reconciliation, provider update/cancel | `summary`, `entities` (signal post), `correlationId` = publication id, `error` on PARTIAL/FAILURE paths |
| `server/publish/confirmations.ts` | `signal-campaign` | `signal.publish-confirmation` | Agent publish confirmation request/decision | `summary`, `entities` (signal post), `correlationId` = confirmation id, `error` on terminal failure states |
| `server/publish/analytics.ts` | `signal-campaign` | `signal.analytics-sync` | Per-delivery figures refresh | `summary` (includes parser warnings inline), `entities` when deliveries measured |
| `server/publish/analytics-window.ts` | `signal-campaign` | `signal.analytics-window-refresh` | Provider window figures refresh | `summary`, `error` on failure |
| `server/publish/inventory.ts` | `signal-campaign` | `signal.provider-inventory-refresh` | Provider inventory refresh | `summary`, `error` on failure |
| `server/publish/buffer-accounts.ts` | `signal-campaign` | `signal.buffer-accounts-refresh` | Buffer channel metadata refresh | `summary`, `error` on failure |
| `server/agent-cost/cost.ts` | `agent-hub` | `agent.cost-refresh` | Agent usage snapshot refresh | `summary` (includes warnings), `error` on failure |

**Registered but not yet produced in production**

| Operation | Status |
| --- | --- |
| `calendar.sync` | Listed in `INTEGRATION_OPERATIONS`; no production writer yet (tests only) |

**Does not write `integration_events`**

Agent coordination handoffs, Signal local edits, workspace CRUD, MCP agent events
(`mcp_agent_events`), and client merge commits — by design per `AGENTS.md`.

---

## Credential and payload safety

### Write path

- Callers pass structured fields only — never a raw HTTP request or provider response dump
  (`server/integration-log.ts` module header).
- The only free-text field an external system reaches is `error`. It passes through
  `redactSecrets` before insert: Bearer tokens, OAuth query parameters, named credential keys,
  Google token shapes, and JWTs are replaced with `[redacted]`; the result is truncated to 500
  characters (`ERROR_MAX`).
- `summary` is caller-authored plain language. Publish and refresh services build it from counts
  and labels, not from provider JSON.
- File bytes never enter the log. Drive upload success records folder/file id and name only.

### Read path

- `GET /api/integrations/activity` is GET-only; POST/PUT/PATCH/DELETE return 404
  (`server/integration-log.test.ts`).
- MCP `integration_list_activity` returns the same rows through `listIntegrationEvents`; write
  tool results elsewhere pass through `redactToolResult`, but activity rows are already scrubbed
  at write time.
- The UI renders `event.error` and `event.summary` as text nodes — no `dangerouslySetInnerHTML`.

### Test evidence

`server/integration-log.test.ts` § credentials proves tokens, secrets, passwords, and refresh
tokens do not survive into stored or returned `error` text, while the message still names the
failing URL and marks redacted segments.

### Debug logging boundary

`docs/debug-logging.md` states the app deliberately has no log panel: request debug output is
not an audit record and would duplicate credential risk. Operators use integration activity for
integration outcomes; server logs stay private.

**Conclusion: credentials and payload bytes cannot appear in the integration activity UI under
current write and read rules.**

---

## Q8 — Surface comparison

| Criterion | (1) Shared panel in Import and Health | (2) Link from Health to Import | (3) No Health surface |
| --- | --- | --- | --- |
| Operator value for non-import events | High — Health eyebrow is already **Operations**; publish, Drive, analytics, and agent-cost events belong there | Medium — Import page title and copy frame **Import**; activity section is global but buried below receipts | Low for ops — Import works but is the wrong mental model for “why did publish fail?” |
| Duplication risk | Low if extracted once (`ActivityRecord` + list shell from `ImportView.tsx`) | None | None |
| Implementation cost | Medium (E2: extract component, optional source filter, mount on Health) | Small (one card + anchor link) | Zero |
| Discoverability from Health | Immediate | Requires navigation and scroll past receipts | N/A |
| Consistency with MCP | Same fields agents already read | Same data, worse placement | Agents have MCP; browser operators rely on Import |
| Maintenance | One component, two mounts | Import remains sole renderer; Health stays thin | Status quo |

### Evidence for operator value

1. **Five sources, twelve production modules** — only two (`campaign-playbook`, `signal-import`)
   are import-shaped. The majority of rows an active workspace generates are Signal publish,
   reconcile, analytics, inventory, Drive sync, and agent-cost refresh events.
2. **Import already lists all sources** — `ImportView` calls `/integrations/activity` without a
   source filter and labels the section “Integration activity”, confirming the log is workspace-wide,
   not import-scoped. Operators troubleshooting Signal or Drive already land on the wrong page.
3. **Health page copy invites it** — `HealthView` describes “historical activity” in its subtitle
   but shows only liveness cards. A read-only activity section completes that promise without
   exposing debug logs.
4. **Receipt correlation stays on Import** — per-receipt audit lines (`eventByReceipt`) remain
   import-specific; the shared panel is the global newest-first list both pages need.

### Decision

**Option 1.** Extract the read-only panel from `ImportView.tsx` into a shared component and
render it on Health under a new **Integration activity** section. Keep receipt correlation on
Import only.

Option 2 is rejected: it preserves the wrong information scent (Import ≠ operations).  
Option 3 is rejected: clear operator value exists for non-import diagnostics from Health.

---

## Q9 — Retention and paging

| Rule | Location | Value |
| --- | --- | --- |
| Table retention | `shared/integration-log.ts` `INTEGRATION_EVENT_LIMIT` | 200 rows |
| Write prune | `server/integration-log.ts` after every INSERT | Deletes rows outside newest 200 |
| Read cap | `listIntegrationEvents` / API / MCP | `min(requested, 200)` |
| Per-row entity cap | `INTEGRATION_EVENT_ENTITY_LIMIT` | 100 listed; `entityCount` keeps true total |

**Pagination: not applicable.** The table cannot exceed 200 rows; one request returns the full
visible history.

**Operator needs:** For a single-workspace command center, 200 append-only audit rows covering
every integration operation is enough to diagnose recent failures and partial imports. Heavy
publish workspaces may lose rows older than ~weeks of activity, but those rows were never a
durable compliance archive — they are a rolling diagnostic window. Raising retention is explicitly
out of scope for W40 (Q9-B).

**UI retention boundary (already on Import, required on Health in E2):**

- Static hint: “The most recent 200 records are kept.” (`ImportView.tsx` field-hint)
- When `events.length === INTEGRATION_EVENT_LIMIT` (200): add “Showing every record currently
  stored; older rows were pruned.” — distinguishes “empty history” from “full buffer”
- When `entityCount > entities.length`: per-row hint already present (“Listing the first N of M”)

---

## UI states (for W40-E2)

| State | Behavior |
| --- | --- |
| **Loading** | Section skeleton or “Loading activity…” until first `/integrations/activity` resolves; do not block Health liveness cards |
| **Empty** | `Empty` compact: “No integration activity yet” + one sentence on what creates rows (mirror Import) |
| **Failure** | `inline-warning` / `role="alert"`: “Activity unavailable” + API error message; liveness cards remain visible |
| **Success** | Newest-first list; optional source filter (API already supports `?source=`); retention hint in section intro |
| **Retention full** | When length === 200, show boundary notice that older rows were pruned (see Q9) |

Optional E2 enhancement: source filter `<select>` using `INTEGRATION_SOURCES` labels — not
required for first ship; API and MCP already support it.

---

## W40-E2 follow-on

**Recommendation: file W40-E2.**

| Field | Value |
| --- | --- |
| Title | C226 — Health integration activity panel (W40-E2) |
| Type | feat |
| Slug | `health-integration-activity` |
| Depends on | W40-E (#634) |
| Scope | Extract shared read-only activity panel; mount on Health; keep Import receipt correlation unchanged; add retention-full notice; focused unit test for shared component; extend `HealthView` test for activity section |
| Non-goals | Pagination, retention increase, raw debug log panel, new write paths |

---

## Acceptance checklist (#634)

- [x] Inventory every producer of `integration_events` and the fields each writes
- [x] Confirm credentials and payload bytes cannot appear in the UI
- [x] Compare Q8 options and record the choice with evidence
- [x] Define empty, loading, failure, and retention-boundary states
- [x] W40-E2 filing recommendation recorded (file, not decline)

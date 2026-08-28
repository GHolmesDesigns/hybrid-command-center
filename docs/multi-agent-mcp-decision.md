# Multi-Agent MCP — Decision Record

Status: **partially implemented.** C111 (coordination MCP tools), C112 (operator inbox), and C113
(network MCP on the hosted origin) shipped. Workspace and Signal MCP tools (MCP-C106–C108) remain
unbuilt — only coordination tools and resources are registered today. This document settles the trust
boundary and tool surface for exposing Hybrid Command Center to IDE agents over MCP. It does not
consume a provider's own MCP server.

Card: C105 (#304). Resolves the v5 multi-agent MCP question. Builds on the Signal-over-MCP
shape already named in [`publishing-integration.md`](publishing-integration.md) §17.2 and
[`post-bridge-integrations-plan.md`](post-bridge-integrations-plan.md) §2 (C84), with C78
(#221) shipped as the orphan-detection prerequisite.

**Nothing in this card bypasses human confirmation for provider publishing.** An agent may plan
into SQLite and read previews; the existing submit path with `planHash` / `reconcileHash` stays
the only road to Post Bridge, Buffer, or any other provider, and that path remains reachable only
from the authenticated UI until a later card makes an explicit security decision otherwise.

---

## 1. The decision

**Ship local stdio and authenticated HTTP MCP beside the existing Node API**, exposing
_coordination_ today and _Signal and workspace planning_ as MCP-C106–C108 land. The server is a thin
adapter over the same domain services and Zod boundaries the HTTP API uses — not a second write
path, not a wrapper around provider MCP servers.

Six things follow:

1. **Audience** — one operator's local IDE agents (Cursor, Claude Code, Codex CLI, and similar).
   There is no second account, no collaborator role, and no agent tenancy inside the workspace.
2. **Transport** — **local stdio** (IDE-spawned on the same host as SQLite) **and authenticated
   HTTP** on the hosted origin (`POST /api/mcp`, C113). Stdio inherits the loopback-only exposure
   model; network MCP requires C51 operator session or a server-issued bearer bound to it.
3. **Architecture shape** — **Signal-over-MCP**: agents read and plan into `signal_posts` and
   the surrounding workspace tables; provider writes stay on the existing publish service with
   human confirmation in the UI.
4. **Provider MCP servers** — **declined.** Consuming Post Bridge's or Buffer's MCP endpoints
   would be a second transport to the same REST calls and would let an agent bypass `plan.ts`,
   the capability matrix, preview, and confirmation — producing exactly the orphan posts C78
   detects.
5. **Network MCP** — **shipped** as C113 (#340) on the public HTTPS origin after C51–C55 merged
   (C115 production cutover). Streamable HTTP MCP uses the same tool surface as stdio; provider-write
   tools remain excluded.
6. **Development coordination** — **deferred.** Coordinating multiple coding agents across Git
   branches and GitHub issues is a different product from exposing this workspace; it is not
   answered here. **Agent handoffs between IDE platforms** on the same workspace are scoped in
   [`agent-coordination-plan.md`](agent-coordination-plan.md) (C109–C112).

---

## 2. Alternatives considered

| Option | Verdict | Reason |
| --- | --- | --- |
| Local stdio MCP beside the API | **Chosen** | Matches today's single-operator, loopback-only model. No new network surface. IDE already spawns stdio MCP servers safely. |
| Secured network MCP (SSE / streamable HTTP on the hosted origin) | **Shipped (C113)** | Live on the hosted origin after C51–C55; session or MCP bearer, CSRF on mutations, same tool surface as stdio. See §8. |
| Consuming a provider's MCP server (Post Bridge, Buffer, third-party) | **Rejected** | Buys nothing the REST client lacks; the write path bypasses this app's source of truth and confirmation flow. Recorded in §17.2 of `publishing-integration.md`. |
| Development-issue coordination MCP (branch/PR/issue tooling only) | **Deferred** | Useful, but not this workspace's data model. A future card may expose GitHub/issue tools under a separate server name so trust boundaries do not mix. |
| Exposing the raw HTTP API to agents without MCP | **Rejected** | Same trust questions without schema discovery, and it tempts ad-hoc scripts that skip validation. MCP tools map one-to-one to existing service methods instead. |

**Network MCP shipped** as C113 after C51 (#177) and C55 (#181) proved operator login, CSRF,
session revocation, and proxy trust on disposable infrastructure (C115 production cutover).

**Revisit provider MCP consumption when** never, unless Post Bridge or Buffer publish a
read-only inventory surface this app cannot reach through the existing adapters — and even then
only as a read-only input to C78-style orphan detection, not as a write path.

---

## 3. Threat model

### 3.1 Assets

| Asset | Location | What loss or misuse looks like |
| --- | --- | --- |
| Workspace data (clients, projects, tasks, Signal schedule) | SQLite on the operator's machine | Wrong edits, duplicate posts, deleted work |
| Google Drive OAuth tokens | Encrypted in SQLite | Exfiltration enables file access under the connected grant |
| Post Bridge / Buffer API keys | Encrypted in SQLite / env | Exfiltration enables provider-side posting outside confirmation |
| Provider inventory and analytics snapshots | SQLite | Misleading planning decisions; not secret, but integrity matters |
| Integration activity log | SQLite | Tampering hides partial failures |

### 3.2 Trust boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  Operator workstation (same OS user)                        │
│  ┌──────────────┐   stdio    ┌──────────────────────────┐   │
│  │ IDE agent    │◄──────────►│ HCC MCP server (new)     │   │
│  │ (Cursor etc) │            │  → domain services       │   │
│  └──────────────┘            │  → same Zod + SQLite     │   │
│                              └───────────┬──────────────┘   │
│  ┌──────────────┐   loopback  │            │                │
│  │ Browser UI   │◄───────────►│  HTTP API  │                │
│  └──────────────┘             └────────────┘                │
└─────────────────────────────────────────────────────────────┘
         │ provider HTTPS (only from publish / refresh paths)
         ▼
   Post Bridge / Buffer / Google Drive
```

**Trusted today:** the operator, their OS user session, and local loopback.

**Not trusted:** any remote MCP client, any provider MCP server acting on behalf of an agent,
any agent-declared identity without operator session binding (network phase only), any tool
argument until validated by Zod at the service boundary.

### 3.3 Threats and mitigations

| ID | Threat | Mitigation in chosen shape |
| --- | --- | --- |
| T1 | Agent publishes to social accounts without operator review | Provider write tools **excluded** from MCP v1; UI-only submit with `planHash` / `reconcileHash` |
| T2 | Agent exfiltrates API keys or OAuth tokens through tool results | MCP tools never return secrets; reuse `redactSecrets`; no `settings` row dumps |
| T3 | Agent writes orphan posts directly at Post Bridge | Do not consume provider MCP; local planning only until UI submit |
| T4 | Unauthenticated network MCP exposes the workspace | Network transport requires C51 session or MCP bearer; stdio has no listener |
| T5 | Two agents race on the same post | SQLite single-writer + optimistic `planHash` invalidation on publish; MCP uses same services |
| T6 | Agent spams provider refresh endpoints | Integration write tools carry the same manual budget as UI; rate-limit MCP integration writes per session |
| T7 | Agent imports destructive playbook data | Import tools require preview hash + explicit commit tool; same transactional rules as HTTP |
| T8 | Agent merges clients irreversibly | Merge tools require preview hash + commit; same confirmation hash as HTTP |
| T9 | Agent triggers Drive sync broadly | `drive.sync` integration write logged; scoped to existing sync rules |
| T10 | Compromised IDE spawns MCP against production host | Hosted MCP requires C51 session or scoped MCP bearer + CSRF |

### 3.4 Threat-model checklist (verification)

Use this checklist in documentation review before any implementation card merges:

- [x] Stdio and authenticated network HTTP (C113) are the chosen transports; C51 named for network.
- [ ] Provider MCP consumption is rejected, not merely unimplemented.
- [ ] Every tool is classified read-only, local write, integration write, or provider write.
- [ ] No provider-write tool is callable without the same confirmation the UI requires — v1 excludes them entirely.
- [ ] Secrets never appear in tool schemas, results, or MCP audit rows.
- [ ] Integration writes that contact externals append `integration_events` rows in the same transaction.
- [ ] Local MCP writes append audit rows without bypassing domain validation.
- [ ] Import and merge flows are two-step (preview → commit) with a hash binding.
- [ ] Concurrent publish attempts fail closed on stale `planHash`.
- [ ] Implementation cards in §10 do not reopen transport or provider-write policy.

---

## 4. Identity, authorization, and confirmation

### 4.1 Agent identity (v1 — local stdio)

| Field | Rule |
| --- | --- |
| **Operator identity** | Implicit: the OS user who spawned the MCP process owns the workspace file. Same as today's HTTP API on loopback. |
| **Agent label** | Optional string the IDE supplies (`clientInfo.name` / MCP initialization metadata). Stored on MCP audit rows for forensics only for workspace/Signal tools; **not** an authorization principal for those tools in v1. Coordination tools (C109+) treat a non-empty label as the agent principal for claim/complete/cancel — see [`agent-coordination-plan.md`](agent-coordination-plan.md) §5.1. |
| **Session binding** | None on stdio. Every tool call is authorized as the operator. |

### 4.2 Agent identity (network MCP — C113 shipped)

| Field | Rule |
| --- | --- |
| **Operator identity** | C51 (#177) session cookie or a server-issued MCP bearer bound to that session. |
| **Agent label** | Required header on every call; stored with audit rows. |
| **Session binding** | MCP bearer revoked when operator logs out, changes password, or restore invalidates sessions (C51, C55). |

### 4.3 Authorization matrix

| Class | Operator (UI) | Agent (MCP v1) | Agent (network, C113) |
| --- | --- | --- | --- |
| Read-only workspace / Signal reads | Allowed | Allowed | Allowed with session |
| Local write (CRUD, planning edits) | Allowed | Allowed | Allowed with session |
| Preview-only publish plans | Allowed | Allowed (preview tools only) | Allowed with session |
| Provider publish / cancel / update / publish-now | Allowed with confirmation hash | **Denied — use UI** | **Denied — use UI** unless a future security card says otherwise |
| Integration write (sync, refresh) | Allowed (person-pressed) | Allowed with audit + rate limit | Allowed with session + audit + rate limit |
| Drive OAuth connect | Allowed (browser redirect) | **Denied — use UI** | **Denied — use UI** |
| Settings: branding, view defaults | Allowed | Allowed | Allowed with session |
| Client merge / playbook import commit | Allowed with preview hash | Allowed with same preview hash | Allowed with same preview hash |

### 4.4 Confirmation rules

| Operation | Confirmation mechanism | MCP v1 |
| --- | --- | --- |
| Publish submit | `planHash` from preview | Not exposed |
| Publish now | `planHash` from publish-now preview | Not exposed |
| Provider reconcile / apply | `reconcileHash` | Not exposed |
| Buffer target apply | `reconcileHash` | Not exposed |
| Client merge | Merge preview hash | Preview + commit tools |
| Playbook import | Import preview hash | Preview + commit tools |
| Signal import | Import preview hash | Preview + commit tools |
| Archive / hard-delete | UI confirmation dialog | Commit tool with explicit `confirm: true` flag + typed entity id |

---

## 5. Idempotency, concurrency, and rate limits

| Concern | Rule |
| --- | --- |
| **SQLite concurrency** | One Node process, one writer. MCP and HTTP share the connection; no MCP-specific bypass. |
| **Publish idempotency** | Unchanged: submit with a stale `planHash` refuses; provider `POST` remains unsafe to repeat. |
| **MCP tool idempotency** | Read tools are safe to repeat. Local writes use natural keys (ids) — PATCH is idempotent by state; CREATE returns a new id. Import/merge commits refuse a reused preview hash after success. |
| **Concurrent agents** | Two agents editing the same post last-write-wins on ordinary PATCH, same as two browser tabs. Publish still requires a fresh preview hash. |
| **Integration refresh budget** | At most **6 integration-write tool calls per rolling minute** per MCP session (inventory, analytics, buffer accounts, drive sync combined). Matches the spirit of the probe budgets without automating person-pressed refresh. |
| **Provider call budget** | Preview tools may call domain preflight only (no provider network). Zero provider network from MCP in v1. |

---

## 6. Secret handling

| Secret | MCP exposure |
| --- | --- |
| `POST_BRIDGE_API_KEY`, `BUFFER_API_KEY` | Never returned; never accepted as tool input |
| Google OAuth tokens | Never returned; connect flow UI-only |
| `GOOGLE_TOKEN_ENCRYPTION_KEY`, session secret | MCP process reads env the same as the server; never in tool output |
| Drive file bytes | Never streamed through MCP; metadata-only reads via existing browse rules |
| Integration log `error` field | Passed through `redactSecrets` before any tool result |

---

## 7. Audit records

| Write class | Audit destination | When |
| --- | --- | --- |
| Integration write | `integration_events` (existing) | Same transaction as today |
| Provider write | `integration_events` (existing) | UI only in v1 |
| Local MCP write | **`mcp_agent_events` (new table, C106+)** | Append-only row per successful or refused mutation tool call |
| Read tools | None | — |

**`mcp_agent_events` row shape (implementation contract):**

- `id`, `at` (UTC ISO), `agent_label` (nullable), `tool`, `outcome` (`SUCCESS` / `REFUSED` / `FAILURE`)
- `entity_type`, `entity_id` (nullable), `summary` (plain words, no secrets)
- Retention: newest **500** rows, same append-only discipline as `integration_events`

Refused provider-write attempts (if a stub tool exists) log `REFUSED` without touching provider state.

---

## 8. Network exposure and cloud-hosting prerequisites

Network MCP **shipped** as C113 (#340) after the following cards merged and C55 verified them
together on disposable infrastructure:

| Prerequisite | Issue | What it supplies for MCP |
| --- | --- | --- |
| C50 — hosting runtime contract | #176 | Named HTTPS origin, proxy trust boundary, secret-store names |
| C51 — operator authentication | #177 | **Named authentication gate** — session cookie, CSRF, login abuse controls, bind gate widening |
| C52 — Drive picker scope | #178 | Least-privilege Drive for a public host |
| C53 — production cloud runtime | #179 | Same-origin static + API, fail-closed startup |
| C54 — hosted backup operations | #180 | Recovery without resurrecting stale MCP sessions |
| C55 — cutover rehearsal | #181 | End-to-end proof of auth + CSRF + proxy + restore invalidation |

C113 exposes streamable HTTP MCP at `POST /api/mcp` on the public origin. Local stdio MCP is
**not blocked** by C50–C55 — it never leaves the workstation.

---

## 9. Tool and resource surface

Tools are grouped by domain. Names are the proposed MCP identifiers; implementation maps each
tool to exactly one existing service method (or declines it). **Owner** is the server module that
already owns the behaviour.

### 9.1 Classification key

| Class | Meaning |
| --- | --- |
| **R** | Read-only — no SQLite mutation |
| **L** | Local write — SQLite only, no external network |
| **I** | Integration write — may contact Drive or a publish provider |
| **P** | Provider write — changes provider-held posts (UI-only in v1) |

### 9.2 Workspace — clients, projects, tasks

| Tool | Class | Owner | Authorization | Audit / confirmation |
| --- | --- | --- | --- | --- |
| `workspace_list_clients` | R | `server/domain/clients` | Operator | — |
| `workspace_get_client` | R | `server/domain/clients` | Operator | — |
| `workspace_create_client` | L | `server/domain/clients` | Operator | `mcp_agent_events` |
| `workspace_update_client` | L | `server/domain/clients` | Operator | `mcp_agent_events` |
| `workspace_archive_client` | L | `server/domain/clients` | Operator | `mcp_agent_events` + confirm flag |
| `workspace_merge_clients_preview` | R | `server/domain/clients` | Operator | — |
| `workspace_merge_clients_commit` | L | `server/domain/clients` | Operator | preview hash + `mcp_agent_events` |
| `workspace_list_projects` | R | `server/domain/projects` | Operator | — |
| `workspace_create_project` | L | `server/domain/projects` | Operator | `mcp_agent_events` |
| `workspace_update_project` | L | `server/domain/projects` | Operator | `mcp_agent_events` |
| `workspace_archive_project` | L | `server/domain/projects` | Operator | confirm flag |
| `workspace_delete_project` | L | `server/domain/projects` | Operator | confirm flag |
| `workspace_list_tasks` | R | `server/domain/tasks` | Operator | — |
| `workspace_create_task` | L | `server/domain/tasks` | Operator | `mcp_agent_events` |
| `workspace_update_task` | L | `server/domain/tasks` | Operator | `mcp_agent_events` |
| `workspace_delete_task` | L | `server/domain/tasks` | Operator | confirm flag |
| `workspace_list_tags` | R | `server/domain/tags` | Operator | — |
| `workspace_manage_tag` | L | `server/domain/tags` | Operator | `mcp_agent_events` |
| `workspace_list_categories` | R | `server/domain/categories` | Operator | — |
| `workspace_manage_category` | L | `server/domain/categories` | Operator | `mcp_agent_events` |
| `workspace_dashboard_summary` | R | `server/domain/dashboard.ts` | Operator | — |
| `workspace_calendar_range` | R | `server/calendar.ts` | Operator | — |

### 9.3 Signal — planning and reads

| Tool | Class | Owner | Authorization | Audit / confirmation |
| --- | --- | --- | --- | --- |
| `signal_list_posts` | R | `server/signal/read.ts` | Operator | — |
| `signal_get_post` | R | `server/signal/read.ts` | Operator | — |
| `signal_list_campaigns` | R | `server/signal/campaigns.ts` | Operator | — |
| `signal_manage_campaign` | L | `server/signal/campaigns.ts` | Operator | `mcp_agent_events` |
| `signal_create_post` | L | `server/signal/service.ts` | Operator | `mcp_agent_events` |
| `signal_update_post` | L | `server/signal/service.ts` | Operator | `mcp_agent_events` |
| `signal_delete_post` | L | `server/signal/service.ts` | Operator | confirm flag |
| `signal_duplicate_post` | L | `server/signal/service.ts` | Operator | `mcp_agent_events` |
| `signal_set_slot` | L | `server/signal/service.ts` | Operator | `mcp_agent_events` |
| `signal_get_variants` | R | `server/signal/service.ts` | Operator | — |
| `signal_update_variants` | L | `server/signal/service.ts` | Operator | `mcp_agent_events` |
| `signal_get_publish_targets` | R | `server/signal/service.ts` | Operator | — |
| `signal_update_publish_targets` | L | `server/signal/service.ts` | Operator | `mcp_agent_events` |
| `signal_queue_snapshot` | R | `server/signal/read.ts` | Operator | — |
| `signal_queue_health` | R | `server/signal/queue-health.ts` | Operator | — |
| `signal_ack_alert` | L | `server/signal/queue-health.ts` | Operator | `mcp_agent_events` |
| `signal_card_delivery_status` | R | `server/signal/read.ts` | Operator | — |
| `signal_publish_preview` | R | `server/publish/service.ts` (`PublishService.preview`; **C122** makes the MCP dispatch path async before this tool ships) | Operator | — (no provider network on preflight) |
| `signal_list_publications` | R | `server/publish/service.ts` | Operator | — |

**Explicitly excluded (P — UI only):** `signal_publish_submit`, `signal_publish_now`,
`signal_provider_apply`, `signal_provider_reconcile`, `signal_buffer_target_apply`,
`signal_publication_finish`.

### 9.4 Signal — media and Drive resolution

| Tool | Class | Owner | Authorization | Audit / confirmation |
| --- | --- | --- | --- | --- |
| `signal_resolve_drive_media` | I | `server/drive/media.ts` | Operator | `integration_events` if Drive call |
| `signal_recheck_post_media` | I | `server/signal/service.ts` | Operator | `mcp_agent_events` + optional Drive |
| `signal_recheck_variant_media` | I | `server/signal/service.ts` | Operator | `mcp_agent_events` + optional Drive |

### 9.5 Files (read-only boundary)

| Tool | Class | Owner | Authorization | Audit / confirmation |
| --- | --- | --- | --- | --- |
| `files_browse_project` | R | `server/drive/browse.ts` | Operator | — |

No upload, download, move, rename, or delete tools — same rule as [`AGENTS.md`](../AGENTS.md).

### 9.6 Integrations and imports

| Tool | Class | Owner | Authorization | Audit / confirmation |
| --- | --- | --- | --- | --- |
| `import_playbook_preview` | R | `server/import.ts` | Operator | — |
| `import_playbook_commit` | L | `server/import.ts` | Operator | preview hash + `integration_events` |
| `import_signal_preview` | R | `server/import.ts` | Operator | — |
| `import_signal_commit` | I | `server/import.ts` | Operator | preview hash + `integration_events` |
| `integration_list_activity` | R | `server/integration-log.ts` | Operator | — |
| `drive_sync` | I | `server/drive/service.ts` | Operator | `integration_events` + rate limit |
| `signal_refresh_provider_inventory` | I | `server/publish/inventory.ts` | Operator | `integration_events` + rate limit |
| `signal_refresh_analytics_window` | I | `server/publish/analytics.ts` | Operator | `integration_events` + rate limit |
| `signal_refresh_buffer_accounts` | I | `server/publish/buffer-accounts.ts` | Operator | `integration_events` + rate limit |

### 9.7 Settings

| Tool | Class | Owner | Authorization | Audit / confirmation |
| --- | --- | --- | --- | --- |
| `settings_get_branding` | R | `server/domain/settings` | Operator | — |
| `settings_update_branding` | L | `server/domain/settings` | Operator | `mcp_agent_events` |
| `settings_get_view_defaults` | R | `server/domain/settings` | Operator | — |
| `settings_update_view_defaults` | L | `server/domain/settings` | Operator | `mcp_agent_events` |
| `settings_get_drive_status` | R | `server/drive/service.ts` | Operator | — |

**UI-only:** Drive OAuth start/callback, root selection, disconnect.

### 9.8 MCP resources (read-only snapshots)

| Resource URI | Class | Owner | Purpose |
| --- | --- | --- | --- |
| `hcc://workspace/summary` | R | compose | Clients/projects/tasks counts |
| `hcc://signal/queue` | R | `server/signal/read.ts` | Unscheduled + upcoming posts |
| `hcc://signal/health` | R | `server/signal/queue-health.ts` | Live alerts |
| `hcc://integrations/recent` | R | `server/integration-log.ts` | Newest integration events |

Resources are optional in the prototype; tools alone satisfy v1.

---

## 10. Implementation cards

Each card assumes this document and does not reopen transport choice, provider MCP consumption,
or provider-write policy.

### Waves, milestones, and end-to-end coverage

These waves continue from Wave 19 (C103). **Wave 20 and Wave 21 milestones already exist** for
provider lifecycle and trust decisions. **Coordination shipped before workspace MCP tools** — C109–C112
and C111 landed while MCP-C106–C108 remain unbuilt. Coordination cards are detailed in
[`agent-coordination-plan.md`](agent-coordination-plan.md). Hardening and the remaining tool surface
are in [`mcp-capability-plan.md`](mcp-capability-plan.md).

| Wave | Cards | Theme | Estimate (sequential) | Status |
| --- | --- | --- | --- | --- |
| 23 — Agent coordination hub | C109–C112, C111 | Handoffs and operator inbox | **~7–17 h** | **Shipped** |
| 24 — Network MCP | C113 | HTTPS MCP after operator auth | **4–8 h** | **Shipped** |
| 22 — Multi-agent MCP | MCP-C106, MCP-C107, MCP-C108 | Workspace and Signal over MCP | **~10–22 h** | **Unbuilt** |
| 26+ — MCP hardening and context | C116–C134 | Defect fixes, reads, writes, streams | per plan | In progress |

**MCP-C106–C108** below are this plan's implementation cards. They are not publishing-wave
C106–C108 (#305–#307).

| Card | Type | Size | Estimate | Wave | Issue |
| --- | --- | --- | --- | --- | --- |
| C105 | `docs` | M | 1–3 h | 22 | #304 |
| MCP-C106 | `feat` | M | 1–3 h | 22 | TBD |
| MCP-C107 | `feat` | L | 4–8 h | 22 | TBD |
| MCP-C108 | `feat` | L | 4–8 h | 22 | TBD |

### C105 — Multi-agent MCP decision (shipped)

**Branch:** `docs/304-multi-agent-mcp-decision`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 22 — Multi-agent MCP
**Issue:** #304 · **Depends on:** —

This card. No runtime change.

### MCP-C106 — Local stdio MCP scaffold and read tools

**Branch:** `feat/<issue>-mcp-stdio-read`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 22 — Multi-agent MCP
**Depends on:** C105 (#304).
**Scope:** `server/mcp/` module, stdio transport, `mcp_agent_events` schema, read-only tools from
§9.2 (list/get), §9.3 (reads), §9.5, §9.7 (gets), health ping. Spawn via `npm run mcp`.
**Out of scope:** Any write tool, network listener, provider call.

### MCP-C107 — Signal and workspace local-write tools

**Branch:** `feat/<issue>-mcp-local-write`
**Size:** L · **Estimate:** 4–8 hours · **Wave / milestone:** 22 — Multi-agent MCP
**Depends on:** MCP-C106.
**Browser coverage:** `e2e/mcp-signal-planning.spec.ts` — agent creates or edits a Signal post via MCP and sees it in the UI.
**Scope:** Local-write tools for workspace CRUD (without merge commit), Signal planning edits,
campaign management, alert ack, settings updates. Confirm flags on destructive ops.
**Out of scope:** Import commit, merge commit, integration writes, publish preview.

### MCP-C108 — Preview, import, and integration-write tools

**Branch:** `feat/<issue>-mcp-integration-write`
**Size:** L · **Estimate:** 4–8 hours · **Wave / milestone:** 22 — Multi-agent MCP
**Depends on:** MCP-C107.
**Scope:** Two-step import/merge, `signal_publish_preview`, Drive media resolve/recheck,
integration refresh tools with rate limits and `integration_events`.
**Out of scope:** Provider submit/apply/cancel/publish-now.

### C109 — Agent coordination hub decision (shipped)

**Branch:** `docs/336-agent-coordination-decision`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 23 — Agent coordination hub
**Issue:** #336 · **Depends on:** C105 (#304); binds to MCP-C106 `agent_label` / `mcp_agent_events`
contracts without requiring that runtime first.
**Scope:** Finalize [`agent-coordination-plan.md`](agent-coordination-plan.md) §4–§8 — handoff
primitive, lifecycle, authorization, audit, threat-model checklist. No runtime change.
**Blocks:** C110, C111, C112.

### C110 — Agent handoff queue (domain and schema)

**Branch:** `feat/<issue>-agent-handoff-queue`
**Size:** L · **Estimate:** 4–8 hours · **Wave / milestone:** 23 — Agent coordination hub
**Issue:** #337 · **Depends on:** C109, MCP-C107.
**Scope:** `agent_handoffs`, `agent_handoff_notes`, `server/domain/agent-coordination.ts`, HTTP
service for operator cancel. See [`agent-coordination-plan.md`](agent-coordination-plan.md) §C110.
**Blocks:** C111, C112.

### C111 — Coordination MCP tools

**Branch:** `feat/<issue>-mcp-coordination-tools`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 23 — Agent coordination hub
**Issue:** #338 · **Depends on:** C110, MCP-C108.
**Scope:** `coordination_*` MCP tools and `hcc://coordination/inbox` resource. Requires
`agent_label` on writes.
**Blocks:** none.

### C112 — Operator coordination inbox (UI)

**Branch:** `feat/<issue>-coordination-inbox-ui`
**Size:** M · **Estimate:** 1–3 hours · **Wave / milestone:** 23 — Agent coordination hub
**Issue:** #339 · **Depends on:** C110.
**Browser coverage:** `e2e/coordination-inbox.spec.ts`.
**Scope:** Agent handoffs panel, `/api/coordination/*`, `e2e/coordination-inbox.spec.ts`.
**Blocks:** none.

### C113 — Network MCP behind operator auth (shipped)

**Branch:** `feat/340-mcp-network`
**Size:** L · **Estimate:** 4–8 hours · **Wave / milestone:** 24 — Network MCP
**Issue:** #340 · **Depends on:** C111, C51 (#177), C53 (#179), C55 (#181). MCP-C108 remains
unbuilt; coordination tools are the live MCP surface today.
**Scope:** Streamable HTTP MCP on the same origin as the API, session + CSRF + agent label header,
coordination tools plus whatever workspace/Signal tools land in MCP-C106–C108.
**Out of scope:** Provider-write tools unless a new security decision record says otherwise.

Full card text: [`agent-coordination-plan.md`](agent-coordination-plan.md).

---

## 11. Narrow prototype plan (MCP-C106)

1. Add `server/mcp/stdio.ts` — JSON-RPC loop, tool registry, Zod validation at boundary.
2. Reuse existing service factories from `server/app.ts` extraction (or inject the same deps tests use).
3. Ship **five** read tools first: `workspace_dashboard_summary`, `signal_list_posts`,
   `signal_get_post`, `signal_queue_health`, `integration_list_activity`.
4. Add `mcp_agent_events` table in `server/db.ts` (append-only, 500-row retention).
5. Document IDE config snippet in README (Cursor `mcp.json` example pointing at `npm run mcp`).
6. Unit tests with mock Drive; no e2e until C107 proves a write path.

**Success criteria for prototype:** an agent can list this week's Signal schedule and queue
health from Cursor without starting the browser, and no tool performs a network call.

---

## 12. Cross-references

- [`publishing-integration.md`](publishing-integration.md) §17.2 — Signal-over-MCP shape and C78 prerequisite (shipped).
- [`post-bridge-api-surface.md`](post-bridge-api-surface.md) §9 — why provider MCP is read-risk, write-danger.
- [`cloud-hosting.md`](cloud-hosting.md) §5 — operator authentication model for network MCP (C113).
- [`AGENTS.md`](../AGENTS.md) — Files read-only boundary, integration log rules, Signal authority.
- [`agent-coordination-plan.md`](agent-coordination-plan.md) — handoff hub cards C109–C113.
- [`mcp-capability-plan.md`](mcp-capability-plan.md) — Waves 26–30 hardening, reads, writes, and
  catalog corrections (C119–C134).

---

## 13. Verification (this card)

- [ ] Documentation review against §3.4 checklist.
- [ ] `npm run format:check`
- [ ] `git diff --check`
- [ ] No runtime, schema, or dependency change in this PR.

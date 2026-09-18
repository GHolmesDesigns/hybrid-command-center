# Live chat conversation platform — planning study

**Status:** **Decisions recorded** — Q1–Q16 answered 16 September 2026; review amendments A1–A4 (§4.10), Appendix B recommendations, and second-review decisions R1–R9 (§4.12) resolved 17 September 2026; **cards filed** 17 September 2026 as issues #669–#676 (see §5 card index)  
**Filing boundary:** Cards C236–C243 are filed as GitHub issues #669–#676 on project **Command Center v6.0.0**. Only C236 (#669) is on a milestone (**Wave 41 — Live chat platform**); later cards stay unmilestoned until their waves are planned.  
**Prepared:** 16 September 2026  
**Revised:** 17 September 2026 — A1–A4 and Appendix B recommendations accepted (auth-key permission matching, light-touch workload, model-aware token forecasting, Live updates copy); R1–R9 recorded (dedicated assistant credential, `workspace:write` scope split prerequisite, approval clock, forecast on overrun, complex and daily caps, `sender_kind` backfill, two-phase copy)  
**Source:** Operator request to plan a live chat conversation platform; reviewed against `origin/main` at **6.10.5** (Wave 39 conversation sync shipped; Agent Hub C202–C219 filed or landed).  
**Theme:** Evolve Hybrid Command Center from durable agent **threads** and coordination **handoffs** into a **live** conversation platform — Command AI becomes an in-app assistant with scoped writes, scoped threads in the drawer, and WebSocket-backed live updates (HTTP remains authoritative).
**Epic start:** **Wave 41** is the starting wave for this live chat platform epic. Phase 1 begins there; later phases remain dependency-ordered and are not pre-assigned to a wave yet.

## Executive summary

Hybrid Command Center is being extended into an in-app live chat platform built on its existing durable conversation and agent-coordination foundation. Operators will be able to open client-, project-, task-, or freeform-scoped threads from the drawer or full Conversations page, see agent messages and notifications arrive without reloads, and use Command AI to receive bounded, streamed replies in the thread.

The assistant will run server-side using an operator-supplied provider key. It acts through a dedicated assistant credential, and its available tools match the scopes granted to that credential under the existing MCP registry checks; every permitted write still requires an explicit approval showing the actual arguments, target, and revision, and each outcome is recorded in the thread audit. HTTP remains authoritative for persisted messages and workspace state, while WebSocket frames provide wake-ups and ephemeral streaming deltas. Secrets, credentials, sensitive client fields, and raw provider payloads remain out of model context, frames, logs, and exports.

Delivery is phased: first establish authenticated WebSocket live updates, then extend drawer synchronization and canonical threads to all workspace scopes, then split the MCP write scopes and add the assistant credential, then add the assistant turn pipeline and approvals, followed by multi-party agent-chat polish. External chat services, provider publishing, Drive byte operations, message editing, browser notifications, and automatic approvals remain outside this build.

**Release note:** This document is planning only. Version bumps happen at merge time per `AGENTS.md`; do not pre-assign version numbers to cards named here.

---

## Study brief

| Question | Current answer |
| --- | --- |
| What exists today? | Durable conversation records, operator compose, @mention → confirmed handoff, MCP agent replies as messages, WebSocket wake-up tips (C236), drawer/full-page sync (Wave 39). |
| What is missing for “live chat”? | No in-app assistant that answers in-thread; no typing/presence; agent replies depend on polling/MCP unless a wake frame triggers a reread; Command AI label implies AI but the drawer is compose-only today. |
| What should this plan produce? | Phased cards from the locked decisions below, beginning with Wave 41 — filed as C236–C243 (#669–#676). |
| What is not being filed yet? | Wave assignment for cards after C236, and semver. |
| Owner decisions | Q1–Q16 locked 16 Sep 2026 — see §4 summary table; A1–A4 amendments accepted 17 Sep 2026 — see §4.10 |

### Terminology

- **Thread:** One row in `agent_conversations` with cursor-paged messages in `agent_conversation_messages`.
- **Live:** A message or state change becomes visible on open surfaces within one debounced refresh cycle after the write, without full navigation or manual reload.
- **Platform:** Shared server contracts, transport, UI surfaces (drawer + full page + scoped discussions), and agent participation rules — not a separate product or external chat host.
- **Assistant turn:** One operator send and everything the assistant does in response — streamed text, zero or more tool calls (bounded, §4.8), and one persisted assistant message or persisted failure message. Distinct from an MCP agent posting through coordination tools.
- **Handoff:** Coordination row created by a confirmed `@agent-label` mention; still the approval boundary for heavy agent **work**; agents may also chat in-thread as peers (Q15).
- **Canonical thread:** The default active conversation for a given scope `(type, id)`; additional scoped threads require **New thread** (Q8).

---

## 0. Current state (baseline)

### Shipped conversation infrastructure

| Layer | What it does |
| --- | --- |
| **Persistence** | `agent_conversations`, participants, messages, linked handoffs, decision marks, archive; scopes: `client`, `project`, `task`, `freeform`. Messages store `sender_label` + `sender_provenance` (`UNKNOWN` / `ASSERTED` / `VERIFIED`). |
| **Operator UI** | Full **Conversations** page (`/agents/conversations`) and **Command AI** drawer — synchronized freeform selection (Wave 39), page context attachment (6.10.3+). |
| **Agent participation** | Agents post messages and complete handoffs through MCP; operator posts as `operator`; conversation listing joins `agent_conversation_participants`. |
| **Mentions** | `@label` → confirm handoffs preview → linked `OPEN` handoff (C210); notification on confirm (C218). |
| **Wake-up transport** | Authenticated WebSocket on `GET /api/agent-hub/ws` upgrade — **wake frames only**; feeds `conversations`, `notifications`, and `coordination`; `AgentHubTipRegistry` broadcasts every tip to every subscriber; gated by the `agent_hub_live_tips` setting (default off). C219 SSE removed in C241 (#674). |
| **What Command AI is not** | An embedded LLM. Sending a message stores it; nothing in HCC generates an assistant reply in the drawer today. |

### Reference docs

- Wave 39 sync contract: `docs/iterations/WAVE_39_COMMAND_AI_CONVERSATION_SYNC.md`
- Agent Hub cards C202–C219: `docs/iterations/AGENT_HUB_CARDS.md`
- Thread rollups (design only): `docs/iterations/THREAD_ROLLUP_DESIGN.md`
- MCP coordination loop: `docs/mcp-agent-workflow.md`

---

## 1. Product intent (owner statement)

> A **live chat conversation platform** inside Hybrid Command Center.

Locked interpretation:

1. **Operator experience:** Chat feels immediate — assistant replies, agent messages, and notifications appear while working elsewhere in the app via WebSocket wake-ups and HTTP reread.
2. **Multi-party:** Operator, in-app assistant (scoped writes), and MCP agents share threads with clear provenance.
3. **Workspace-bound:** Drawer shows **scoped** threads (client, project, task) as well as freeform — not only page-context attachments.
4. **One thread, many surfaces:** Drawer and full page stay synchronized for **all accessible scopes**; Wave 39 freeform-only rule is **superseded** by this initiative (see §4.3).

---

## 2. Gap analysis — “thread store” vs “live chat platform”

| Capability | Today | Live platform target |
| --- | --- | --- |
| Message delivery to open UI | WebSocket wake-up → debounced HTTP reread (C236) | Same; assistant token streaming on same socket (Q10) |
| Message delivery when tab backgrounded | Reread on visibility / navigation | Unchanged in v1; browser notifications are a non-goal (§6) |
| Assistant replies in Command AI | None | Operator message → bounded assistant turn in-thread (Phase 3) |
| Agent replies in-thread | Agents can post via MCP if they choose | **Chat peers (Q15):** agents may post freely as participants; handoffs for heavy work, not every message |
| Typing / presence | Agent presence directory exists; no per-thread typing | Optional Phase 5; does not block MVP |
| History | Cursor-paged HTTP | Unchanged; live layer sits on top |
| Edit / delete message | Not supported | Non-goal (§6) |
| External chat (Slack, SMS) | None | Out of scope for HCC platform |
| Authoritative live payload | Refused by design (WebSocket wake frames) | **Keep refusal** — frames wake or stream partial assistant text only until HTTP confirms persistence |

---

## 3. Architectural principles (carry forward)

These are inherited from AGENTS.md and Agent Hub; a live chat layer must not weaken them.

1. **HTTP is authoritative.** WebSocket frames carry wake-up hints and **non-authoritative** assistant streaming tokens only — persisted messages, handoff state, and unread counts come from authenticated HTTP reads after each material change.
2. **Handoffs stay confirmed.** `@mention` work routing remains opt-in per send; live chat must not auto-create handoffs from casual text.
3. **Provenance visible.** Operator, scoped-credential agent, asserted agent, and assistant turns must be distinguishable in the UI and must not be spoofable (§4.11).
4. **No secrets on the wire.** Live frames name feeds and ids; operator LLM API keys never leave server-side storage; provider requests never echo keys into frames or logs.
5. **Single SQLite writer.** Live transport fans out from the same process that holds the writer lock; do not open a second write path. **No transaction or writer lock is held across a provider call.**
6. **Degrade safely.** If WebSocket drops, reconnect with backoff; navigation and HTTP refresh still load correct state; partial stream tokens must reconcile to the persisted HTTP message or be discarded.
7. **Untrusted content cannot cause writes.** Thread messages (including `ASSERTED` agents), task/project text, and tool read results are untrusted model input. No write executes without an operator approval showing the actual tool arguments (§7.1, §7.4).

---

## 4. Decisions (recorded 16 September 2026)

| # | Question | Owner decision |
| --- | --- | --- |
| Q1 | First milestone | **B — In-app assistant in Command AI** (operator message → assistant reply in-thread) |
| Q2 | Assistant boundary | **B — Scoped writes** via existing workspace write paths (tasks, projects, etc.); no publish/Drive widening |
| Q3 | Provider | **A — Operator-supplied API key** (server-side only; never returned to browser) — storage clarified in §4.2 |
| Q4 | Drawer scope | **B — Scoped threads in the drawer** (client, project, task, and freeform synchronized with full page) |
| Q5 | Transport | **B — WebSocket** (C219 SSE removed in C241; WebSocket is the shell live channel) |
| Q6 | Feature flag | **Option 2 — Assistant flag implies tips** (enabling assistant enables live WebSocket subscription) — *amended by A2* |
| Q7 | Follow-page behavior | **B — Prompt on scope change** (“Switch to **Acme Studio** project chat?”; never silent auto-switch) |
| Q8 | Threads per scope | **C — One canonical + New thread** (default canonical active thread; explicit action for a second scoped thread) |
| Q9 | C219 SSE migration | **Done** — one-release parallel completed; C241 (#674) removed SSE after production verification (18 Sep 2026) |
| Q10 | Assistant streaming v1 | **A — Stream tokens** (`assistant_delta` on WebSocket; HTTP persist at end) |
| Q11 | LLM providers v1 | **B — OpenAI + Anthropic** (operator picks provider in Settings; one active provider per request) |
| Q12 | Write confirmation | **B — Tiered confirm** (see §7.1) |
| Q13 | Allowed write tools | **D — Mirror MCP agent grant** — *amended by A1 and R1–R3: scopes granted to a dedicated assistant credential, after the `workspace:write` split* |
| Q14 | Data to LLM | **D — Tool reads + redaction list** (see §7.2) |
| Q15 | MCP agents in chat | **C — Chat peers** (agents may post in threads they participate in; handoffs for heavy work) |
| Q16 | Assistant off | **C — Same as today** (threads + @mention handoffs; no assistant) — *amended by A4* |

### 4.1 Assistant + scoped writes (Q2 detail)

The assistant acts as a **dedicated assistant credential** (R1): a credential issued through the same path as MCP agent credentials, bound to the reserved `command-ai` identity (§4.11), with scopes the operator chooses in Settings. It may call the bounded handlers whose registry `requiredScope` that credential grants (§7.3). The operator session never lends its own scopes to the assistant. Subject to:

- Explicit **approval UI** before every permitted write (§7.1); the assistant cannot widen the existing handler boundaries, and provider publishing/Drive byte operations remain out of this initiative’s implementation scope.
- **Revision and validation** rules unchanged — failed writes surface as assistant messages with structured errors, not silent retries.
- **Stale approvals:** the revision of the target captured when the write is **proposed** is the `expectedRevision` used when the approved write executes; a conflict surfaces as a structured error and a fresh proposal, never a blind retry.
- **Audit:** each tool invocation logged in-thread (tool name, target id, outcome); no credential or raw provider payload in the thread.
- **Scope default:** when the selected thread is scoped, writes default to that client/project/task; freeform threads require explicit target resolution in the approval card.

Write policy is locked in **§7.1–§7.4** (Q12–Q14).

### 4.2 Operator API key + providers (Q3, Q11 detail)

- Settings: **provider** (`openai` | `anthropic`), **API key**, and bounded **model** picker per provider.
- **Storage:** keys are entered in Settings at runtime, so they cannot live in SSM (SSM `/hcc/production/*` is deploy-time env written by the owner, and the instance holds no AWS write credentials). Keys are encrypted at rest in SQLite using the same AES-GCM helper as Drive tokens (`encryptJson` / `decryptJson` in `server/drive/tokens.ts`), keyed by a **new** env secret `ASSISTANT_KEY_ENCRYPTION_KEY` delivered via SSM like other secrets. Do not reuse `GOOGLE_TOKEN_ENCRYPTION_KEY` — rotating one integration must not invalidate the other. Config validation rejects a missing/short key only when the assistant is enabled.
- One key slot per provider (both storable); Settings selects the one **active** provider; no multi-provider fan-out in v1.
- Settings API returns `{ provider, model, hasKey: boolean, keyLast4? }` only — never the key.
- **Daily caps (R7):** persisted **per-day** caps on assistant turns and provider-reported tokens, stored server-side, not per session — a re-login must not reset them. The server ships defaults (planning values: **100 turns** and **300,000 provider-reported tokens** per day; the Phase 3 card confirms them); Settings lets the operator **lower** either cap but never raise it above the server default. Forecast calls (below) count toward both caps. Reaching a cap ends or refuses the turn with a persisted explanatory message.
- **Token profiles:** use provider/model-specific token profiles rather than one universal token number. No local dollar-spend estimate is authoritative.
- **Forecast on overrun (R5):** every turn starts under the light-touch profile (§4.8). A turn that reaches a light-touch limit pauses; the server runs one bounded forecast call (no tool calls) estimating remaining tool calls and output range, and the operator approves or declines continuing as a complex run. Declining ends the turn with a persisted message. The forecast never replaces hard server caps, credential scopes, or per-write approval. If provider usage reporting is unavailable, do not offer the complex run; persist an explanatory message instead.
- Redact secrets from assistant error paths and `integration_events` free text.

### 4.3 Scoped drawer (Q4 detail — supersedes Wave 39 §2.1 Option A)

Wave 39 intentionally synchronized **freeform only**. This initiative **extends** that contract:

- Drawer lists and opens **active** threads for all scopes the operator can access (same filters vocabulary as full page, possibly simplified).
- Selection bridge syncs drawer ↔ `/agents/conversations?open=` for **any** scope, not only freeform.
- **Follow-page (Q7):** see §4.6.
- **Canonical thread (Q8):** see §4.7.
- Archived / missing threads: keep fail-closed explanatory states from Wave 39 §2.3.

Update `USER_MANUAL.md` and help copy when this ships; Wave 39 doc remains historical context.

### 4.4 WebSocket transport (Q5 detail)

**New surface:** authenticated WebSocket on the app origin (`/api/agent-hub/ws` upgrade).

**Frame vocabulary (draft):**

| Frame kind | Direction | Authoritative? | Purpose |
| --- | --- | --- | --- |
| `wake` | server → client | No | Names feeds (`conversations`, `notifications`, `coordination`) and optional `conversationId` — client debounces HTTP reread |
| `subscribe` / `unsubscribe` | client → server | No | Declares which `conversationId` the socket is displaying, for delta routing |
| `assistant_delta` | server → client | No | Streaming text for in-progress assistant turn, keyed by `turnId`; replaced by persisted message on `wake` + reread |
| `assistant_turn_state` | server → client | No | `started` / `awaiting_approval` / `finished` / `failed` / `cancelled` for UI state only; HTTP reread is the truth |
| `ping` / `pong` | both | No | Keepalive |

**Server implementation requirements:**

- **Dependency:** Express 5 has no WebSocket support; add the `ws` package and handle `upgrade` on the `http.Server` returned by `app.listen` in `server/index.ts`.
- **Origin check:** CORS middleware does not apply to upgrades. The upgrade handler rejects any `Origin` that does not exactly match `config.appOrigin` (cross-site WebSocket hijacking defence). Test with a foreign Origin → 403.
- **Session auth:** Express session middleware does not run on `upgrade`; the handler parses and validates the session cookie explicitly with the same store and rejects unauthenticated upgrades before accepting. Session expiry or logout closes open sockets.
- **Routing:** `wake` frames may fan out to every authenticated socket (same as today's broadcast `AgentHubTipRegistry`). `assistant_delta` and `assistant_turn_state` are **not** broadcast — they go only to sockets of the operator who owns the turn that are subscribed to that `conversationId`.
- **Frame limits:** max inbound frame size and per-socket message rate; unknown client frame kinds close the socket with a policy code.
- **Shutdown:** `server.close()` does not close upgraded sockets. Track open sockets and close them (going-away code) on shutdown; covered by `server/agent-hub/ws.test.ts`.
- **New `coordination` feed:** `AGENT_HUB_TIP_FEEDS` today is only `conversations` + `notifications`. Add `coordination` to the shared vocabulary and emit it from handoff create/claim/complete/cancel write paths (needed by Phase 4).

**Infrastructure:**

- Caddy v2 `reverse_proxy` forwards WebSocket upgrades without extra directives; the `deploy/aws/` work is documenting idle timeout behaviour and choosing a server `ping` interval shorter than any proxy/load-balancer idle timeout.
- **C219 SSE:** removed in C241 (#674) after production verification (18 Sep 2026).

**Client:** `useAgentHubTips` uses WebSocket; reconnect with backoff + last-seen generation guard (W40 stale-response lessons); reconnect banner after repeated failure.

**Not on WebSocket:** persisted message bodies, handoff rows, notification counts, or workspace snapshots.

### 4.5 Feature flag coupling (Q6 detail — see amendment A2)

- Two persisted settings: `agent_hub_live_tips.enabled` (existing key, becomes “Live updates”) and a new assistant setting (`command_ai_assistant.enabled` + provider/model).
- **Phases 1–2:** “Live updates” toggle (existing key) gates the WebSocket. No assistant toggle exists yet.
- **Phase 3:** Settings shows **Command AI assistant** as the primary toggle. Enabling it forces live updates on (and the live-updates control shows as locked on while the assistant is on). Disabling the assistant leaves live updates at the operator's last choice.
- Defaults remain **off** for both (no behavior change for existing deployments).
- **Approved copy (R9, two-phase):** label the existing setting **Live updates**.
  - **Phases 1–2 helper text:** “Keep conversation messages and notifications current while you work.”
  - **Phase 3 helper text:** same sentence; while the assistant is on and the control is locked, append “Required while Command AI is on.”
  - **Phase 1 release note:** “Live update tips is now Live updates. It keeps open conversations and notifications current without requiring a reload.”
- Assistant enabled without a stored key → drawer shows a “Add an API key in Settings” state; no provider call.

### 4.6 Follow-page prompt (Q7)

- Prompt appears when **page scope** (from route/breadcrumb) differs from **selected thread scope** and a canonical thread exists or can be created for the page scope.
- Does not fire on freeform-only navigation. When the drawer is closed, no prompt; when it next opens, it evaluates the current page scope once.
- Accept → select canonical thread (creating it if absent) + sync URL when on Conversations page.
- Decline → keep selection; do not ask again for the same `(pageScope, threadScope)` pair for the browser session (session-local dismiss map; not durable).

### 4.7 Canonical thread (Q8)

- Stored as an explicit `agent_conversations.is_canonical` flag (additive migration), set on create.
- Enforced by a partial unique index on `(scope_type, scope_id) WHERE is_canonical = 1 AND archived_at IS NULL` (adjust column name to the schema); a shared server helper resolves canonical id.
- **Archiving the canonical thread** clears the flag; no automatic promotion. The next “project chat” open offers **promote an existing secondary thread** or **create new canonical**.
- Opening “project chat” from prompt or drawer defaults to canonical.
- **New thread** in scoped context creates a sibling non-canonical thread; UI badge “Secondary thread”.
- Freeform: no canonical concept; unlimited active freeform threads as today.

### 4.8 Assistant turn lifecycle and streaming (Q10)

- **One turn per thread at a time.** A send while a turn is running in that thread is rejected with a visible “Assistant is still replying — cancel or wait” state (not queued). Sends from a second tab obey the same server-side lock.
- **Cancel:** operator can cancel a running turn; pending approvals are withdrawn; tool calls already executed stay executed and remain in the audit lines.
- **Bounds per turn:** hard server ceilings for maximum tool calls, wall-clock, and output tokens. Hitting a bound pauses for the forecast (§4.2) under light-touch, or ends the turn under a complex run; either way the persisted message names the limit reached (for example “Stopped at the 3 tool-call limit”), not a generic failure.
  - **Light-touch profile (every turn starts here):** at most 3 tool calls, 60 seconds wall-clock, and 2,000 output tokens.
  - **Complex run ceiling (R6, fixed server values):** at most 12 tool calls, 5 minutes wall-clock, and the selected provider/model’s configured output-token ceiling. An approved forecast cannot raise these; the Phase 3 card confirms the numbers.
- **Approval clock (R4):** time spent awaiting an operator approval (inline or blocking) is **excluded** from the wall-clock limit. Pending approvals expire separately after **15 minutes**; expiry withdraws the approval and ends the turn with a persisted message.
- **Streaming:** `assistant_delta` frames render in a provisional bubble; on `wake` + HTTP reread, replace with the persisted assistant message row.
- **Failure:** on provider error, timeout, or cap exhaustion, discard deltas and **persist a short failure message** (redacted, no provider payload) so every surface and reload shows what happened.
- **Approvals across reconnect:** pending approvals are persisted server-side (not only on the socket) so a reconnect or reload shows them via HTTP; they expire after 15 minutes or when the turn ends, whichever comes first.
- Partial assistant text is never persisted as a normal message.

### 4.9 MCP agents as chat peers (Q15)

- Agents with conversation access may post messages via MCP (`conversation_post_message`) as today without a handoff.
- Handoffs remain required for **confirmed @mention work** and for coordination lifecycle (claim/complete).
- Update `docs/mcp-agent-workflow.md` and client help: chat vs handoff distinction.
- Phase 4 polishes live reread when agent posts; no new agent protocol required for v1.

### 4.10 Review amendments (accepted 17 September 2026)

Found in the 16 September 2026 review against `main`. On 17 September 2026 the owner accepted A2–A4 as recommended and revised A1 (the recommended assistant allowlist was replaced by credential scopes; see R1–R3 in §4.12). The sections above reflect the accepted resolutions. The rejected alternatives are kept for context.

| # | Affects | Problem | Accepted resolution | Rejected alternative |
| --- | --- | --- | --- | --- |
| **A1** (owner-revised) | Q13, §7.3 | The assistant must not invent a second permission model that diverges from the scopes carried by the authenticated key. | Assistant uses the granted scopes of its dedicated credential (R1) and the existing registry `requiredScope` checks, exactly as MCP does. If a finer distinction is needed than the current scope vocabulary provides, refine the credential scope model and registry metadata (first instance: R2 scope split); do not add an assistant-only exclusion list. Tests compare assistant and MCP access decisions for the same granted scopes. | A separate hard-coded assistant allowlist. |
| **A2** | Q6, §4.5, phases | Assistant toggle is built in Phase 3, but Phases 1–2 gate the WebSocket on it — the transport could not be enabled or verified in production before Phase 3. | Keep `agent_hub_live_tips` (“Live updates”) as the WebSocket gate in Phases 1–2; in Phase 3 the assistant toggle forces it on (§4.5). | Ship the assistant toggle in Phase 1 with no assistant behind it (confusing label until Phase 3). |
| **A3** | Q9 | Removing SSE while assistant-off gets no WebSocket strands operators who enabled live tips today. | Phase 1 served WebSocket to every “Live updates” user; SSE fallback ran one release; C241 (#674) removed SSE after prod verification. No operator lost live updates. | Keep SSE indefinitely for assistant-off (two transports to maintain). |
| **A4** | Q16 | “Same as today” and “no WebSocket when assistant off” become contradictory once SSE is removed. | Assistant off = no assistant; **wake-only WebSocket if Live updates is on**; nothing if off. | Accept that live updates require the assistant (a regression for current live-tips users; needs release-note copy). |

### 4.11 Assistant identity and provenance

- Reserved sender label `command-ai`. Agent registration and MCP identity resolution **reject** `command-ai` (and case/whitespace variants) so no agent can post as the assistant; test both paths.
- Add a separate `sender_kind` column with `operator` / `agent` / `assistant` values. The assistant pipeline alone may write `assistant`; the value must be unsettable from HTTP message posts and MCP. Keep this distinct from `sender_provenance`, which continues to describe identity trust.
- **Migration (R8):** additive column; backfill existing rows — `sender_label = 'operator'` → `operator`, every other row → `agent` — then make the column `NOT NULL`. Migration test covers both backfill branches and rejects a later insert without `sender_kind`.
- The assistant is **not** an `agent_conversation_participants` row (it must not appear in MCP agents' conversation listings or be @mentionable); message listing already returns all messages for the thread regardless of participants.
- `@command-ai` is not a handoff target; mention parsing ignores it.

### 4.12 Second-review decisions (recorded 17 September 2026)

Raised in the second review of the owner-revised plan; owner accepted every recommendation.

| # | Topic | Decision | Where applied |
| --- | --- | --- | --- |
| **R1** | Assistant principal | **Dedicated assistant credential** issued through the MCP agent credential path, bound to `command-ai`, operator-chosen scopes, revocable, visible in audit. Operator session scopes are never lent to the assistant. | §4.1, §7.3, Phase 3 prerequisite |
| **R2** | Scope vocabulary | **Split `workspace:write` before Phase 3** as a prerequisite card: `workspace:write` keeps task/project/checklist/dependency/merge tools; new `signal:write`, `settings:write`, `import:write`, `drive:sync`. Existing credentials holding `workspace:write` are migrated to also hold the new scopes so current MCP access is unchanged. | §7.3, Phase 3 prerequisite |
| **R3** | Tier map role | **Scopes are the gate; the tier map is a safety net.** A scope-authorized write with no assigned tier fails closed with a structured error until a card assigns one. | §7.1, §7.3 |
| **R4** | Approval clock | **Approval wait excluded** from wall-clock; pending approvals expire after 15 minutes. | §4.8 |
| **R5** | Forecast trigger | **On overrun:** every turn starts light-touch; hitting a limit pauses for one tool-free forecast call and operator approval. Forecast counts toward daily caps. | §4.2, §4.8 |
| **R6** | Complex run caps | **Fixed server ceiling:** 12 tool calls, 5 minutes (approval wait excluded), model output-token ceiling; forecast cannot raise it. | §4.8 |
| **R7** | Daily caps | **Server defaults, operator can lower:** planning defaults 100 turns and 300,000 provider-reported tokens per day. | §4.2 |
| **R8** | `sender_kind` migration | **Backfill, then `NOT NULL`** (`operator` label → `operator`; all else → `agent`). | §4.11 |
| **R9** | Live updates copy | **Two-phase copy:** Phases 1–2 helper sentence; Phase 3 appends “Required while Command AI is on” when locked. | §4.5 |

---

## 5. Phases and filed cards

Phases reflect locked decisions, A1–A4, and R1–R9. Each card is implemented one PR at a time per AGENTS.md.

### Card index (filed 17 September 2026)

| Card | Issue | Plan section | Milestone | Priority / size |
| --- | --- | --- | --- | --- |
| C236 - WebSocket live channel (W41-A) | [#669](https://github.com/GHolmesDesigns/hybrid-command-center/issues/669) | Phase 1 | Wave 41 — Live chat platform | P1 / XL |
| C237 - Scoped drawer synchronization and canonical threads (LC-P2) | [#670](https://github.com/GHolmesDesigns/hybrid-command-center/issues/670) | Phase 2 | — | P1 / XL |
| C238 - MCP scope split, assistant credential, and sender kind (LC-P3-PRE) | [#671](https://github.com/GHolmesDesigns/hybrid-command-center/issues/671) | Phase 3 prerequisite | — | P1 / L |
| C239 - In-app Command AI assistant (LC-P3) | [#672](https://github.com/GHolmesDesigns/hybrid-command-center/issues/672) | Phase 3 | — | P1 / XXL |
| C240 - Multi-party live chat polish (LC-P4) | [#673](https://github.com/GHolmesDesigns/hybrid-command-center/issues/673) | Phase 4 | — | P2 / M |
| C241 - Remove C219 SSE live-tip route (LC-SSE) | [#674](https://github.com/GHolmesDesigns/hybrid-command-center/issues/674) | Phase 1 follow-up (Q9/A3) | — | P2 / S |
| C242 - Agent presence and typing in threads (LC-P5) | [#675](https://github.com/GHolmesDesigns/hybrid-command-center/issues/675) | Phase 5 (optional) | — | P2 / L |
| C243 - Thread rollups for long conversations (LC-P6) | [#676](https://github.com/GHolmesDesigns/hybrid-command-center/issues/676) | Phase 6 (optional) | — | P2 / L | **Order is mandatory** — assistant without WebSocket and scoped drawer will not meet the stated UX.

### Phase 1 — WebSocket live channel

**Card:** C236 (#669) · follow-up C241 (#674)

**Goal:** Shell subscribes to one WebSocket when **Live updates** is enabled (A2); wake frames trigger debounced HTTP reread.

- `ws` dependency; upgrade route on the `http.Server`; explicit Origin check and session-cookie auth on upgrade (§4.4).
- Shared frame schema in `shared/` (`wake`, `subscribe`/`unsubscribe`, `ping`/`pong`; `assistant_delta` + `assistant_turn_state` types stubbed for Phase 3).
- Add `coordination` feed to the tip vocabulary and emit it from handoff write paths.
- Socket tracking + close on shutdown; frame size/rate limits.
- Client hook replaces EventSource; Conversations + Command AI + notification badge reread on wake.
- **SSE parallel (Q9/A3):** completed — C241 (#674) removed the C219 SSE route after production verification (18 Sep 2026).
- Settings copy: “Live update tips” → “Live updates”; same persisted key.
- Regression: wake for other `conversationId` does not clobber selection; disconnect/reconnect; HTTP fallback on navigation; foreign Origin rejected; unauthenticated upgrade rejected; logout closes socket.

**Likely touch:** new `server/agent-hub/ws*.ts`, `server/index.ts`, `server/agent-hub/tips.ts`, `client/src/useAgentHubLive.ts`, `deploy/aws/` docs, `shared/agent-hub-tips.ts`.

### Phase 2 — Scoped drawer synchronization

**Card:** C237 (#670)

**Goal:** Drawer and full page share selection for **all scopes**; scoped threads appear in drawer history.

- Extend conversation selection bridge beyond freeform (Wave 39 B/C follow-on).
- Drawer thread list: active scoped + freeform; explanatory states for archived/missing.
- **Q7** scope-change prompt (§4.6) + **Q8** `is_canonical` flag with partial unique index and archive behaviour (§4.7) + **New thread** for secondary scoped threads.
- E2E: select project thread in drawer → URL updates on Conversations page; send from either surface → one message row.

**Depends on:** Phase 1 (live reread must work for scoped threads).

**Supersedes:** Wave 39 freeform-only drawer contract.

### Phase 3 prerequisite — MCP scope split and assistant credential

**Card:** C238 (#671)

**Goal:** The scope vocabulary can express Q2, and the assistant has its own credential before any assistant turn exists (R1, R2).

- Extend `MCP_AGENT_SCOPES` in `shared/mcp-agent-registry.ts` with `signal:write`, `settings:write`, `import:write`, `drive:sync`.
- Reassign `requiredScope` in `server/mcp/registry.ts`: `signal_*` writes → `signal:write`; `settings_update_*` → `settings:write`; `import_*_commit` → `import:write`; `drive_sync` → `drive:sync`. Task, project, checklist, dependency, and merge-commit tools stay `workspace:write`.
- Additive credential migration: every existing credential with `workspace:write` also receives the four new scopes, so no current MCP client loses access. Credential issuance UI lists the new scopes.
- Assistant credential: issued through the same credential path, bound to reserved label `command-ai`, scopes chosen by the operator in Settings (default `workspace:read` + `workspace:write`), revocable; `command-ai` rejected for ordinary agent credentials (§4.11).
- Tests: registry test asserts every tool's new `requiredScope`; migration test proves pre-split credentials keep an identical tool-access matrix; issuance rejects `command-ai` for non-assistant credentials.
- Docs: `docs/mcp-agent-workflow.md` scope table.

**Depends on:** none (can land in parallel with Phases 1–2); must merge before Phase 3.

### Phase 3 — In-app assistant (milestone)

**Card:** C239 (#672)

**Goal:** Operator enables assistant + API key; messages in drawer threads receive assistant replies with scoped writes.

- Settings: assistant toggle forcing Live updates on (§4.5); **OpenAI + Anthropic** provider + encrypted API key (`ASSISTANT_KEY_ENCRYPTION_KEY`, §4.2) + model picker; assistant credential scopes; per-day caps with operator-lowerable defaults (R7).
- Reserved `command-ai` identity and trusted sender kind (§4.11).
- Provider adapter interface with OpenAI, Anthropic, and a **deterministic stub adapter** used by unit, integration, and E2E tests.
- Server pipeline: thread + scope + **on-demand read tools** authorized by the assistant credential (§7.3); tool loop over the credential-authorized write handlers with **tiered approval** (§7.1); redaction module applied to context **and** tool results before every provider call (§7.2).
- Turn lifecycle: per-thread lock, cancel, light-touch and complex bounds, forecast on overrun, approval clock and 15-minute expiry, limit-named failure messages, persisted pending approvals, stale-revision handling (§4.1, §4.2, §4.8). No DB transaction spans a provider call.
- Persist assistant messages; **stream tokens** (Q10) via `assistant_delta` routed only to the owning operator's subscribed sockets, then `wake` + HTTP.
- UI: approval cards showing the **actual tool arguments** and target; in-thread tool audit lines; provenance badge distinct from MCP agents.

**Depends on:** Phases 1–2 and the Phase 3 prerequisite.

**Out of slice:** Publish submit, Drive bytes, assistant turns not started by an operator send, external training, remembered/auto approvals.

### Phase 4 — Multi-party polish

**Card:** C240 (#673)

**Goal:** MCP **chat peers** (Q15) and handoff state feel live in the same threads.

- Handoff chips update on `coordination` wake (feed added in Phase 1); agent participant messages reread like operator/assistant.
- @mention confirm flow unchanged; document chat-vs-handoff in MCP guides.
- Optional: promote agent to participant on first in-thread post.

**Depends on:** Phase 3.

### Phase 5 — Presence and typing (optional)

**Card:** C242 (#675)

**Goal:** Operators see when a registered agent is online and optionally “typing” in a thread.

- Reuse `agent_list_presence` / presence store; typing is ephemeral server state with TTL, not persisted messages.
- WebSocket `typing` frames (non-authoritative); clients show indicator; HTTP does not store typing rows.

**Depends on:** Phase 1–2; low priority unless operator demand.

### Phase 6 — Rollups and long-thread UX (optional)

**Card:** C243 (#676)

**Goal:** Implement C216 design when threads exceed threshold.

- See `docs/iterations/THREAD_ROLLUP_DESIGN.md` — operator-confirmed rollups only.

---

## 6. Explicit non-goals (first version)

- External chat networks (Slack, Discord, email threads as first-class peers).
- Public/anonymous chat rooms.
- Message edit, unsend, or reactions (unless a later card revokes this).
- Browser/OS notifications for backgrounded tabs.
- Replacing MCP coordination — handoffs remain the work queue; chat does not silently complete tasks.
- Durable message content in WebSocket frames (streaming deltas are ephemeral until HTTP persist).
- Real-time collaborative editing of tasks/Signal posts inside the chat composer.
- Remembered, batch, or automatic write approvals.
- Mobile-native apps (responsive web only).

---

## 7. Safety and approval boundaries

Live chat must inherit existing gates:

| Action | Boundary |
| --- | --- |
| Publish / Signal submit | Still coordination + human confirmation; not triggered by chat send alone |
| Drive write | Separate grant (`drive:write-request`, `drive:sync` after R2); assistant cannot widen Files |
| Workspace mutations | Assistant credential scopes and registry `requiredScope` only (§7.3, A1, R1–R3); revision rules unchanged |
| @mention | Still requires confirm-handoffs preview before `insertHandoff` |
| Agent casual chat | Allowed as participant (Q15); does not replace handoff for scoped work items |

### 7.1 Write approval tiers (Q12 — tiered)

Every write authorized by the assistant credential needs an operator approval before it executes. Tiers differ in how much friction the approval carries, not in whether it is required.

| Tier | Tools | Operator UX |
| --- | --- | --- |
| **Blocking confirm** (destructive or structural) | `workspace_delete_task`, `workspace_delete_project`, `workspace_merge_clients_commit`, `workspace_create_project` | Blocking card: plain-language summary, full argument list, affected record counts (merge uses `workspace_merge_clients_preview` output), summary hash; operator must press **Confirm** on that card. Turn pauses until confirmed or declined. |
| **Inline approve** (additive or reversible edits) | `workspace_create_task`, `workspace_update_task`, `workspace_update_project`, `workspace_add_checklist_item`, `workspace_update_checklist_item`, `workspace_remove_checklist_item`, `workspace_add_dependency`, `workspace_remove_dependency` | Inline card in the thread with field diff and actual arguments; **Approve** / **Decline** per tool call. No “approve all” in v1. |
| **Untiered writes (safety net, R3)** | Any write the assistant credential's scopes authorize but that has no tier assigned above (for example `signal:write` tools if an operator grants that scope) | Fails closed: the call is refused with a structured in-thread error naming the tool. A card must assign a blocking or inline tier before the call can run. Scopes remain the access gate; the tier map only prevents an unreviewed write from running without an approval design. |

`workspace_merge_clients_preview` is a **read** (`workspace:read`) and is invoked by the server to build the merge confirm card — it is not an approval tier.

Tests assert tier membership from server-side operation policy and registry metadata, not string copies in UI.

### 7.2 LLM data policy (Q14 — tool reads + redaction)

**May send to provider:**

- Current thread messages (bounded window).
- Scoped subject summary from bounded reads (same caps as MCP context tools).
- Results of **on-demand read tools** the assistant invokes during the turn (logged in-thread).
- Ephemeral page context when operator attached it for that send.

**Redact before provider call (never send)** — applied by one server module to the assembled context **and to every tool result** before it is returned to the model:

- Operator passwords, session tokens, MCP bearer tokens, API keys.
- `GOOGLE_TOKEN_ENCRYPTION_KEY`, `ASSISTANT_KEY_ENCRYPTION_KEY`, and decrypted Drive tokens.
- Client `email`, `phone`, and free-text `notes` — **always stripped**, including when quoted by the operator (the quote stays in the persisted thread; the provider copy is redacted).
- Full integration log payloads; raw provider API responses.
- Signal publish credentials; post-bridge/buffer secrets.
- Database paths, internal file paths, SSM parameter names.

One module shared by OpenAI and Anthropic adapters; unit tests per field class, including a tool-result case.

### 7.3 Credential tool permissions (Q13 as amended by A1, R1–R3)

The assistant calls the **same handlers** as MCP under its **dedicated assistant credential** (R1). That credential's resolved `grantedScopes` and the registry entry's `requiredScope` are the access decision; there is no assistant allowlist, scope filter, or client-side tool list. The §7.1 tier map is a fail-closed safety net on top of scopes, not a second access list (R3).

A tool is callable only when it is available in the registry and the assistant credential grants its `requiredScope`. A missing required scope produces the same structured refusal used by MCP. Every write that passes this check still requires the operator approval described in §7.1.

The pre-split vocabulary cannot express Q2 (`workspace:write` currently covers Signal, settings, import, and `drive_sync` tools), so the **Phase 3 prerequisite** card splits it into `workspace:write`, `signal:write`, `settings:write`, `import:write`, and `drive:sync` (R2). The assistant credential defaults to `workspace:read` + `workspace:write`. Any later distinction the vocabulary cannot express is added to the scope model and registry metadata, not encoded as an assistant-only exclusion.

Tests issue credentials with each supported scope combination and verify that assistant and MCP produce the same tool-access matrix, including refusal for missing scopes. Future capability expansion updates the scope vocabulary, credential issuance, registry metadata, and this shared permission-matrix test together.

### 7.4 Prompt injection

- Model input includes content the operator did not write: `ASSERTED`/`VERIFIED` agent messages, task and project text, tool results. Treat all of it as untrusted.
- The only control that matters is §7.1: no write without an operator approval rendered from the **actual tool call arguments** (not model-written summaries).
- Approval cards show the target record's name and id resolved server-side.
- Assistant system prompt states that instructions inside thread content or tool results are data; this is defence in depth, not the control.
- Test: an agent message instructing the assistant to delete a project produces at most a blocking confirm card, never an executed delete.

---

## 8. Verification sketch

When cards file, each phase should add:

| Layer | Evidence |
| --- | --- |
| **Unit** | Tip debounce, stale-response guards, provenance on new message types, redaction per field class (context + tool results), assistant/MCP permission-matrix parity against credential scopes and registry metadata, scope-split credential migration (identical pre/post access), untiered-write fail-closed, `sender_kind` backfill, reserved `command-ai` label rejection |
| **Integration** | Post message → WebSocket wake → reread returns new row; no duplicate on replay `clientRequestId`; foreign Origin / no session upgrade rejected; deltas not delivered to non-owning or unsubscribed sockets; shutdown closes sockets; turn lock, cancel, limit-named failure messages, forecast on overrun, approval wait excluded from clock, 15-minute approval expiry, and daily-cap refusal with the stub provider |
| **E2E** | Two-browser or simulated agent post: operator sees reply without reload; Phase 3 milestone spec uses the **stub provider adapter** for streaming + approval flow |
| **Production** | Health + login smoke; optional `eval:mcp-smoke` read-only; WebSocket connect through Caddy; no owner-run provider probes |

Wave milestone rule: at least one new `e2e/` spec when a **milestone** closes, not necessarily every card.

---

## 9. Related work — merge or sequence

| Item | Relationship |
| --- | --- |
| Wave 39 (shipped) | Prerequisite — freeform selection bridge; **extended** in Phase 2 for all scopes |
| W40-A drawer loop fix | Prerequisite — stale-response guards must survive WebSocket + scoped sync |
| C219 SSE | Removed by C241 (#674) after one-release parallel with WebSocket (A3) |
| C216 rollups | Phase 6 or parallel docs-only; no blocker |
| C215 scheduled agent runs | Orthogonal — scheduled work ≠ live chat |
| MCP C132 change feeds | Same “tip → cursor” mental model; do not duplicate cursor state in live frames |

---

## 10. Next steps

1. **Product:** Wireframe Q7 scope-change prompt, Q8 canonical vs secondary thread badges, and §7.1 blocking vs inline approval cards.
2. **Engineering spike (Phase 1):** shipped in C236 (#669); SSE fallback removed in C241 (#674).
3. **Schema sketch (Phase 2):** `is_canonical` + partial unique index on `agent_conversations` — additive migration.
4. **Scope split sketch (Phase 3 prerequisite):** new scope names, `requiredScope` reassignment table, and additive credential migration (R2).
5. **Cards filed:** C236–C243 (#669–#676). Start with C236 (#669) in **Wave 41**; C238 (#671) may run in parallel with C236/C237. Assign later cards to waves as they are planned. Keep one implementing PR at a time per AGENTS.md.
6. **Docs:** Update MCP agent workflow scope table with the Phase 3 prerequisite, and for Q15 chat peers when Phase 4 files.

---

## Appendix A — User-visible success (draft)

**After Phase 1–2 (WebSocket + scoped drawer):**

- Operator turns on **Live updates** → WebSocket connects; operators who had live tips on keep live updates with no action.
- On a project page, scope-change **prompt** offers the canonical project thread; accept syncs drawer + `?open=` on Conversations page.
- MCP agent reply to selected thread appears in drawer and full page without reload.

**After Phase 3 (assistant):**

- Operator enables **Command AI assistant** (Live updates turns on with it) and adds a provider key.
- Operator asks “add a checklist item for review mockups” in a **task-scoped** thread → assistant shows an inline approval card with the actual arguments → operator approves → item appears on task; outcome visible in thread.
- Assistant streaming visible during generation; final message matches HTTP reread after persist.
- Provider failure or cancel leaves a visible, persisted explanation in the thread.
- API key never visible in browser devtools, Settings responses, or thread export.

**Always:**

- Confirmed @mention → one handoff; decline → plain text only.
- WebSocket disconnect → reconnect banner; manual refresh recovers truth.

---

## Appendix B — Resolved open questions

1. **Per-turn bounds:** every turn starts light-touch (3 tool calls, 60 seconds, 2,000 output tokens); complex runs are capped at 12 tool calls, 5 minutes, and the model output-token ceiling (R6). Approval wait is excluded from the clock; approvals expire after 15 minutes (R4).
2. **Model-aware token policy:** provider/model-specific token profiles, forecast on overrun (R5), hard server caps, and provider-reported token accounting. If provider usage is unavailable, the complex run is not offered; local dollar-spend estimates are not authoritative.
3. **Daily caps:** server defaults of 100 turns and 300,000 provider-reported tokens per day, lowerable by the operator (R7); Phase 3 card confirms the numbers.
4. **Legacy live-tips copy:** **Live updates** label with two-phase helper text (R9, §4.5).
5. **Sender kind:** separate `sender_kind` column, backfilled then `NOT NULL` (R8, §4.11).
6. **Assistant principal and scopes:** dedicated assistant credential (R1) after the `workspace:write` scope split (R2); tier map is a fail-closed safety net (R3).

No remaining open questions.

Resolved in the 16 September review (previously open): canonical storage (explicit flag, §4.7); per-provider keys (both storable, one active, §4.2); batch approve (none in v1, §7.1); prompt dismiss persistence (session-only, §4.6).

---

## Appendix C — Decision index (Q1–Q16, A1–A4, R1–R9)

| Q | Decision |
| --- | --- |
| Q1 | In-app assistant first |
| Q2 | Scoped writes |
| Q3 | Operator API key (encrypted in SQLite, §4.2) |
| Q4 | Scoped threads in drawer |
| Q5 | WebSocket |
| Q6 | Assistant toggle enables live updates (A2: Live updates gates Phases 1–2) |
| Q7 | Prompt on scope change |
| Q8 | Canonical thread + New thread |
| Q9 | SSE parallel one release — completed; C241 removed SSE (A3) |
| Q10 | Stream tokens v1 |
| Q11 | OpenAI + Anthropic v1 |
| Q12 | Tiered write approval |
| Q13 | Mirror MCP write grant (A1, R1–R3: assistant credential scopes after scope split) |
| Q14 | Tool reads + redaction list |
| Q15 | MCP agents as chat peers |
| Q16 | Assistant off = today (A4: wake-only WebSocket if Live updates on) |
| A1–A4 | A2–A4 accepted as recommended; A1 owner-revised, 17 September 2026 (§4.10) |
| R1–R9 | Second-review decisions, all accepted as recommended, 17 September 2026 (§4.12) |

---

_Changelog for this doc:_

- _2026-09-16 — initial draft._
- _2026-09-16 — Q1–Q6 recorded; phases reordered for WebSocket → scoped drawer → assistant._
- _2026-09-16 — Q7–Q16 recorded; §7 approval matrix drafted; ready for card filing._
- _2026-09-16 — Review against `main`: A1–A4 amendments proposed (§4.10); named assistant tool allowlist (§7.3, later replaced by owner-revised A1); tier corrections (§7.1); key storage moved from SSM to encrypted SQLite (§4.2); WebSocket Origin/session/routing/shutdown requirements (§4.4); `coordination` feed; assistant identity (§4.11); turn lifecycle (§4.8); canonical index and archive rule (§4.7); prompt injection (§7.4); stub provider for tests (§8)._
- _2026-09-17 — Owner accepted A1–A4 and the Appendix B recommendations; A1 follows authenticated-key permissions rather than a separate assistant allowlist; sender kind uses a separate column; light-touch workload, model-aware forecasting, and Live updates copy are resolved; ready for card filing._
- _2026-09-17 — Second review: R1–R9 recorded (§4.12) — dedicated assistant credential; `workspace:write` split as a Phase 3 prerequisite card; tier map as fail-closed safety net; approval wait excluded from clock with 15-minute expiry; forecast on overrun; fixed complex-run ceiling; operator-lowerable daily cap defaults; `sender_kind` backfill then `NOT NULL`; two-phase Live updates copy. Wording fixes: §4.10 intro, A1 marked owner-revised, 16 September changelog entry corrected, duplicate §7.3 paragraph removed, executive summary approval wording._
- _2026-09-17 — Cards filed: C236–C243 as issues #669–#676 on project Command Center v6.0.0; milestone **Wave 41 — Live chat platform** created for C236 (#669); §5 card index and per-phase card references added._
- _2026-09-18 — C241 (#674): production verification recorded (WebSocket through Caddy, wake → reread, reconnect); C219 SSE route removed; shared vocabulary renamed to `shared/agent-hub-tips.ts`._

# Hybrid Command Center over MCP — guide for Claude chat and Claude Cowork

Audience: Claude running in **claude.ai chat** or **Claude Cowork**, connected to Hybrid Command
Center (HCC) over hosted HTTPS MCP. Claude Code has its own wrapper at
`.claude/skills/hybrid-command-center/SKILL.md`.

Policy source of truth is **`docs/mcp-agent-workflow.md`**. This file does not replace it — it adds
what these two surfaces need, and what makes the connection efficient rather than merely working.

Verified against server **5.9.5**, capability `mcp-d3c51687`, on 2026-08-30.

---

## 1. What you are connected to

| | |
|---|---|
| Transport | Hosted HTTPS (streamable), `POST https://<origin>/api/mcp` |
| Auth | `Authorization: Bearer <credential>` |
| Store | One production SQLite store, identified by `storeId` |
| Surface | ~60 tools, 4 resources, 5 prompts |

**The hosted HTTPS origin is the sole authoritative store for the shared coordination inbox.** Local
stdio connections expose identical tools, labels, and capability versions while answering from a
*different* file. A coordination write over stdio succeeds locally and never reaches the operator's
inbox. On chat and Cowork you are always on HTTPS, so this matters mainly when comparing notes with
an agent that may not be.

---

### Connecting on these surfaces

Chat and Cowork use **claude.ai connector settings** — not `claude_desktop_config.json`, and not any
repository file.

Hybrid Command Center speaks **MCP OAuth** on hosted deployments with operator authentication enabled.
The connector dialog needs only a **name** and **server URL** — Claude discovers authorization from
the server's `401` response and well-known metadata, registers itself, and walks you through sign-in
and approval in the browser.

1. Ask the operator to open **Agents → Agent connection setup** in HCC and register the agent label
   you expect (for example `claude-cowork`). OAuth creates or reuses a registration from the
   connector name at approval time.
2. In claude.ai, **Settings → Connectors → Add custom connector**. Name it Hybrid Command Center
   and paste `https://<origin>/api/mcp`.
3. Click **Connect** in Claude. Sign in to Hybrid Command Center if prompted, review the agent label
   and scopes, then **Approve connector**.
4. Enable the connector for the chats or projects that need it.

After approval, ask Claude to call **`system_connection_status`** and read **`agentLabel`** and
**`storeId`** before any coordination writes.

### Request headers (optional beta)

Some organization accounts also expose a **Request headers** section for static bearer tokens.
Hybrid Command Center does not require it when OAuth is available — OAuth owns the `Authorization`
header on those connections. If you use Request headers anyway, enter `Bearer ` followed by the
token; a bare token returns HTTP 401.

Three failure modes, all observed in practice:

- **Approval skipped or denied.** Claude shows no MCP tools until the browser flow completes.
- **Wrong deployment origin.** The URL must be the hosted HTTPS origin ending in `/api/mcp`, not a
  local stdio checkout.
- **A 401 often surfaces as "server unreachable."** Treat a connection failure as an auth problem
  first, before assuming the host is down.

Never paste a credential into a chat message, a repository file, or a document. OAuth-issued tokens
can be rotated by removing and re-adding the connector, or by revoking the agent credential on the
Agents page.

---

## 3. First move in any session

Call **`system_connection_status`**. It is read-only, writes nothing, and creates no handoff.

```
ok, authenticated, agentLabel, grantedScopes,
storeId, serverVersion, capabilityVersion,
checks: toolsList / resourcesList / resourceRead
```

Read two fields before doing anything else:

- **`agentLabel`** — your identity for every coordination write. It comes from the credential, not
  from a header. If it is not the label you expect, stop; you are holding someone else's credential.
- **`storeId`** — compare it against any other agent's before coordination writes. Different values
  mean different stores, and your write will not be seen.

Do **not** post a handoff to test the connection. `system_connection_status` is the sanctioned check;
a test handoff is listed under "MCP never" in the workflow doc.

---

## 4. The loop: claim → work → prove

1. **Inspect** — read `hcc://coordination/inbox?state=open`, or call `coordination_list_handoffs`.
   Prefer handoffs directed at your label.
2. **Claim** — `coordination_claim_handoff` *before* any work. If the claim is refused or another
   agent owns it, stop.
3. **Context** — `coordination_get_handoff`, then `workspace_get_subject_context` when the subject
   has a type and ID. Keep reads bounded to the subject and its blockers.
4. **Work** — add `coordination_add_note` when progress matters to the operator.
5. **Prove** — `coordination_complete_handoff` with `outcome`, `resultSummary`, and evidence.
   Outcomes: `SUCCEEDED`, `PARTIALLY_SUCCEEDED`, `BLOCKED`, `SUPERSEDED`. Prose alone is not proof;
   fill `validations`, `changedPaths`, `references`, and `remainingRisks`.

---

## 5. Efficiency

**Prefer resources over repeated tool calls.** Four are registered:

| URI | Use |
|---|---|
| `hcc://coordination/inbox` | Open and claimed handoffs; supports `?state=open` / `?state=claimed` |
| `hcc://coordination/changes` | Resumable coordination changes after `?after=<cursor>` |
| `hcc://workspace/context` | Bounded workspace capability descriptor |
| `hcc://workspace/changes` | Resumable workspace changes after `?after=<cursor>` |

**Resume, do not re-read.** After a disconnect, read `hcc://coordination/changes?after=<cursor>`
rather than pulling the whole inbox again. An expired cursor returns `cursor_expired` — reload a
snapshot, then resume from the new cursor.

**If resource support is weak on your surface, call `system_capabilities` instead.** It returns the
same bounded descriptor as `hcc://workspace/context`, with optional `sections` and `include` filters.
This is the intended fallback for clients whose resource handling is limited.

**Use the prompts rather than improvising the loop.** Fetch with `prompts/list` and `prompts/get`:

| Prompt | When |
|---|---|
| `start_claimed_work` | You have a handoff ID and need claim → context → begin |
| `review_project_status` | Inspect workspace health before proposing work |
| `prepare_handoff` | Package work for another agent |
| `verify_before_complete` | Check evidence fields before completing |
| `triage_signal_queue` | Read Signal queue health before scheduling |

**Send `clientRequestId` on every write.** `coordination_post_handoff`, `coordination_add_note`, and
`coordination_complete_handoff` all accept it and treat it as idempotent. A retry after a timeout
then costs nothing instead of creating a duplicate.

**Keep handoff messages short.** Long message bodies are **truncated** when read back through MCP —
observed repeatedly, including a case where the claiming agent could not see the instructions it was
being asked to follow. Put the ask in the first few lines. Evidence belongs in notes and in the
completion's structured fields.

**Reach for the right tool family** instead of scanning ~60 tools:

| Family | Covers |
|---|---|
| `coordination_*` | Handoffs: post, list, get, claim, note, complete, cancel |
| `work_*` | Long-running work: start, heartbeat, checkpoint, blocked, request input, complete, release, resume context |
| `workspace_*` | Clients, projects, tasks, checklists, dependencies, search, dashboard |
| `signal_*` | Signal queue, posts, variants, publish preview, analytics, provider inventory |
| `import_*` | Playbook and Signal import preview/commit |
| `integration_*`, `settings_*`, `files_*`, `drive_*` | Activity, branding and view defaults, project files, Drive sync |
| `system_*` | `system_connection_status`, `system_capabilities` |

**Batch independent reads.** Dashboard summary, queue health, and inbox reads do not depend on each
other — issue them together rather than in sequence.

---

## 6. Boundaries — stop and ask the operator

MCP **never**:

- Publishes to a social provider (Buffer, Post Bridge, or any publish path)
- Writes to Google Drive (upload, move, rename, delete, byte transfer)
- Creates a test handoff as a connection check

Stop and ask rather than guessing when:

- A claim is refused, expired, or owned by another agent
- Subject context is missing, ambiguous, or points at archived records
- Completing would require provider publish or Drive mutation
- Evidence is incomplete and the schema marks fields required
- Rate-limit or scope errors appear — do not retry in a tight loop
- Queue health or publish preview shows blocking alerts you cannot resolve

---

## 7. Quick reference

```
1. system_connection_status              -> confirm agentLabel + storeId
2. hcc://coordination/inbox?state=open   -> find work
3. coordination_claim_handoff            -> before doing anything
4. coordination_get_handoff
   workspace_get_subject_context         -> bounded context
5. coordination_add_note                 -> progress the operator should see
6. coordination_complete_handoff         -> outcome + resultSummary + validations
```

Short messages. `clientRequestId` on every write. Compare `storeId` before trusting that a write
landed where you think it did.

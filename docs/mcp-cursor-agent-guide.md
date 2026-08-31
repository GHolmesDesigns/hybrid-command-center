# Hybrid Command Center over MCP — guide for Cursor agents

Audience: agents running in **Cursor IDE** (Agent mode, subagents, Autopilot) or **Cursor Cloud
Agents**, connected to Hybrid Command Center (HCC) over MCP. The thin skill wrapper lives at
`.cursor/skills/hybrid-command-center/SKILL.md`.

Policy source of truth is **`docs/mcp-agent-workflow.md`**. This file does not replace it — it adds
what Cursor surfaces need, how they differ from each other, and what makes the connection efficient
rather than merely working.

Verified against repository **5.9.7** on 2026-08-30. Client-parity findings from
`docs/iterations/VERSION_5B_FEASIBILITY_REPORT.md` (Codex reconciliation pass) are incorporated
here.

---

## 1. What you are connected to

| | |
|---|---|
| Transport | Hosted HTTPS (streamable), `POST https://<origin>/api/mcp` — **required for shared coordination** |
| Auth | `Authorization: Bearer <credential>` |
| Store | One production SQLite store per origin, identified by `storeId` |
| Surface | ~60 tools, 4 resources, 5 prompts |

**The hosted HTTPS origin is the sole authoritative store for the shared coordination inbox.** A local
stdio connection (`npm run mcp` via `.cursor/mcp.json`) exposes identical tools, labels, and
capability versions while answering from a *different* file. A coordination write over stdio succeeds
locally and never reaches the operator's inbox or another agent on prod.

Cursor can also reach HCC through **shell** (curl to `localhost:8787` while `npm run dev` runs) or
the **browser UI**. Those paths use whichever database that server instance holds — not necessarily
the same store as your MCP connection. **MCP parity does not mean parity with shell or every browser
HTTP route.**

---

## 2. Cursor surfaces — one backend, separately verified clients

Unlike Claude Desktop vs Claude Code, Cursor does not use a wholly different product for chat. The
risk is narrower but real: **several Cursor execution contexts can all read and write the same HCC
API** while believing they share state when they do not.

| Surface | Typical MCP path | Store risk |
|---|---|---|
| **IDE Agent** (this chat) | User or project MCP settings → HTTPS prod | Low if HTTPS only; **high** if stdio or dev server is also configured |
| **Cloud Agent** | HTTPS prod on Cursor's VM (no local stdio, no localhost) | Must be configured separately; same prod `storeId` as IDE when both use prod |
| **Subagents** (`Task` tool) | Inherits the parent's MCP session | Same `agentLabel` as parent — not a separate identity |
| **Shell / curl** during `npm run dev` | `http://127.0.0.1:8787/api/...` | **Local dev DB only** — invisible to prod MCP and the operator inbox |
| **Browser UI** | Operator session on the same origin as prod | Same store as HTTPS MCP when both hit prod |

**Acceptance criteria before trusting cross-surface writes:**

1. Every surface that must share the inbox returns the **same `storeId`** from
   `system_connection_status`.
2. Each surface has its **own traceable label and credential** when it acts independently
   (`cursor-ide`, `cursor-cloud`, …). Do not reuse one credential across IDE and Cloud unless you
   accept claim collisions and ambiguous audit.
3. Prove writes by **reading back through MCP on prod**, not by assuming shell output or a local dev
   response succeeded globally.
4. Do **not** create test handoffs as a connection check. Scope grants alone are not write evidence.

The operator's in-app connection diagnostic is **server health only** (C136-6): it can pass while
your client still holds a revoked credential. Confirm **Last used** updates for your label on
**Agents → Connection health** after your first successful MCP call.

---

## 3. Connecting in Cursor

### IDE Agent (local)

1. Ask the operator to open **Agents → Agent connection setup** in HCC, register your label, and
   issue a scoped credential. The credential is shown **once**.
2. In Cursor, open **Settings → MCP** (or **Tools & MCP**). Add or edit the Hybrid Command Center
   entry.
3. Click **Copy ready-to-paste setup** on the Agents page and paste it where Cursor asks for server
   configuration. Save and reload MCP when Cursor offers it.
4. Do **not** hand-edit repository JSON to store the bearer. Never commit a token.

**Project vs user config:** Cursor merges MCP from user settings and `.cursor/mcp.json` at the
project root. An empty project file (`mcpServers: {}`) means user-level config alone applies. If
stdio is added to the project file while user settings point at HTTPS prod, you can have **two
connections to two stores** — compare `storeId` on each before coordination writes.

**Local stdio is for workstation-local experimentation only.** Do not use it for handoffs, claims,
or completes that must reach Settings or other agents. Route those through HTTPS prod.

### Cloud Agent

Cloud Agents run on Cursor's VM. They cannot use local stdio or `localhost:8787`.

1. Issue a **separate credential and label** (for example `cursor-cloud`) on the Agents page.
2. Configure HTTPS MCP in the Cloud Agent environment with the same origin and bearer as the guided
   setup describes for Cursor.
3. Run `system_connection_status` from the cloud session and confirm the prod `storeId` matches the
   IDE session when both must share the inbox.

### Known setup pitfalls (C136)

- **Missing `Bearer ` prefix** in the Authorization header → HTTP 401, often shown as "server
  unreachable."
- **`x-agent-label` is unnecessary on connector-style surfaces and risky on file paste.** Your label
  is carried inside the credential. A header that *disagrees* with the credential is a hard error. If
  the copied JSON still includes `x-agent-label`, ensure it matches the credential exactly or remove
  it after confirming your client sends Authorization only.
- **After rotate**, reload MCP in Cursor. The old bearer is revoked; until you paste the replacement,
  every call fails.

---

## 4. First move in any session

Call **`system_connection_status`**. It is read-only, writes nothing, and creates no handoff.

```
ok, authenticated, agentLabel, grantedScopes,
storeId, serverVersion, capabilityVersion,
checks: toolsList / resourcesList / resourceRead
```

Read two fields before doing anything else:

- **`agentLabel`** — your identity for every coordination write. It comes from the credential. If it
  is not the label you expect, stop; you are holding someone else's credential.
- **`storeId`** — compare it against every other Cursor surface (IDE, Cloud, any stdio entry) and
  against what the operator sees on Agents before coordination writes. Different values mean different
  stores, and your write will not be seen elsewhere.

If **Drive** shows `NOT_CONNECTED` over MCP but the browser UI shows Drive connected, you are
almost certainly on a **different store** than the operator's browser session. Reconnect Drive on
the store your MCP session uses, or switch MCP to the prod origin the browser uses — do not assume
a second OAuth is required.

---

## 5. The loop: claim → work → prove

1. **Inspect** — read `hcc://coordination/inbox?state=open`, or call `coordination_list_handoffs`.
   Prefer handoffs directed at your label. After a disconnect, resume with
   `hcc://coordination/changes?after=<cursor>` instead of re-reading the whole inbox.
2. **Claim** — `coordination_claim_handoff` *before* any work. If the claim is refused or another
   agent owns it, stop.
3. **Context** — `coordination_get_handoff`, then `workspace_get_subject_context` when the subject
   has a type and ID. Keep reads bounded to the subject and its blockers.
4. **Work** — add `coordination_add_note` when progress matters to the operator. For long-running
   work, use `work_start`, `work_heartbeat`, and `work_checkpoint` so a crashed chat can resume.
5. **Prove** — `coordination_complete_handoff` with `outcome`, `resultSummary`, and evidence.
   Outcomes: `SUCCEEDED`, `PARTIALLY_SUCCEEDED`, `BLOCKED`, `SUPERSEDED`. Prose alone is not proof;
   fill `validations`, `changedPaths`, `references`, and `remainingRisks`.

**Subagents:** a `Task` subagent shares your MCP connection and `agentLabel`. Notes and completions
from a subagent appear under your identity. Either do coordination writes from the parent session or
make the division explicit in handoff notes.

---

## 6. Efficiency

**Prefer resources over repeated tool calls.** Four are registered:

| URI | Use |
|---|---|
| `hcc://coordination/inbox` | Open and claimed handoffs; supports `?state=open` / `?state=claimed` |
| `hcc://coordination/changes` | Resumable coordination changes after `?after=<cursor>` |
| `hcc://workspace/context` | Bounded workspace capability descriptor |
| `hcc://workspace/changes` | Resumable workspace changes after `?after=<cursor>` |

**Resume, do not re-read.** An expired cursor returns `cursor_expired` — reload a snapshot, then
resume from the new cursor.

**If resource reads fail in your session, call `system_capabilities` instead** — same bounded
descriptor as `hcc://workspace/context`, with optional `sections` and `include` filters.

**Use the prompts rather than improvising the loop.** Fetch with `prompts/list` and `prompts/get`:

| Prompt | When |
|---|---|
| `start_claimed_work` | You have a handoff ID and need claim → context → begin |
| `review_project_status` | Inspect workspace health before proposing work |
| `prepare_handoff` | Package work for another agent |
| `verify_before_complete` | Check evidence fields before completing |
| `triage_signal_queue` | Read Signal queue health before scheduling |

**Send `clientRequestId` on every write.** Retries after Autopilot or chat timeouts stay idempotent.

**Keep handoff messages short.** Long message bodies may truncate when read back through MCP. Put the
ask in the first few lines; evidence belongs in notes and completion fields.

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

**Do not use shell to coordinate.** Posting to `/api/agent-handoffs` on localhost seeds the *local*
dev database. Other agents and the operator inbox on prod will not see it. Use MCP coordination tools
on HTTPS prod instead.

---

## 7. Boundaries — stop and ask the operator

MCP **never**:

- Publishes to a social provider (Buffer, Post Bridge, or any publish path)
- Writes to Google Drive (upload, move, rename, delete, byte transfer)
- Creates a test handoff as a connection check
- Commits import playbooks or Signal imports without an operator-approved preview and confirm

Stop and ask rather than guessing when:

- A claim is refused, expired, or owned by another agent
- Subject context is missing, ambiguous, or points at archived records
- Completing would require provider publish or Drive mutation
- Evidence is incomplete and the schema marks fields required
- Rate-limit or scope errors appear — do not retry in a tight loop
- Queue health or publish preview shows blocking alerts you cannot resolve
- `storeId` differs between your MCP connection and the surface you need to agree with

---

## 8. Quick reference

```
1. system_connection_status              -> confirm agentLabel + storeId
2. hcc://coordination/inbox?state=open   -> find work
3. coordination_claim_handoff            -> before doing anything
4. coordination_get_handoff
   workspace_get_subject_context         -> bounded context
5. coordination_add_note                 -> progress the operator should see
6. coordination_complete_handoff         -> outcome + resultSummary + validations
```

Separate labels for IDE and Cloud. Coordination writes through HTTPS prod only. Compare `storeId`
before trusting that a write landed where you think it did. Never coordinate through shell or
localhost API.

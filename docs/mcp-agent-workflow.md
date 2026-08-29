# Hybrid Command Center — MCP agent workflow

This document is the single source of truth for how an agent connects to Hybrid Command Center
(HCC), claims work, executes it, and proves completion. Platform-specific skill wrappers point here;
they do not restate this policy.

## Connect once

1. Ask the operator to register your agent label in **Settings → Agent connection setup** and issue
   a scoped credential.
2. Copy the generated client configuration into your IDE's MCP settings. Never commit a bearer
   token to the repository.
3. Confirm the connection: the operator runs the read-only diagnostic in Settings, and your label
   should show a **Last used** timestamp after your first successful call.

Network MCP requires operator authentication on the host. Local stdio transport runs
`npm run mcp` from the repository checkout and uses `MCP_AGENT_LABEL` in the server environment.

## Claim → work → prove

Every handoff follows the same loop:

1. **Inspect** — Read `hcc://coordination/inbox?state=open` or call `coordination_list_handoffs`
   before taking work. Prefer handoffs directed at your label. After a disconnect, resume with
   `hcc://coordination/changes?after=<cursor>` instead of re-reading the whole inbox; an expired
   cursor means reload a snapshot first.
2. **Claim** — Call `coordination_claim_handoff` before doing any work. If the claim is refused or
   another agent owns it, stop.
3. **Context** — Call `coordination_get_handoff`, then `workspace_get_subject_context` when the
   subject has a type and ID. Keep reads bounded to the subject and its blockers.
4. **Work** — Do the task. Add notes with `coordination_add_note` when progress matters to the
   operator.
5. **Prove** — Call `coordination_complete_handoff` with structured evidence: outcome, result
   summary, and any artifact references the tool schema requires. Prose alone is not proof.

Use MCP prompts rather than improvising the loop:

| Prompt | When to use |
| --- | --- |
| `start_claimed_work` | You have a handoff ID and need the claim → context → begin sequence |
| `review_project_status` | Inspect workspace health before proposing work |
| `prepare_handoff` | Package work for another agent |
| `verify_before_complete` | Check evidence fields before completing |
| `triage_signal_queue` | Read Signal queue health before scheduling work |

Fetch prompts with `prompts/list` and `prompts/get` on your MCP transport.

## Boundaries — stop and ask the operator

MCP **never**:

- Publishes to a social provider (Buffer, Post Bridge, or any publish path)
- Writes to Google Drive (upload, move, rename, delete, or byte transfer)
- Creates a test handoff as a connection check — use `system_connection_status` instead

When either action is needed, stop and obtain explicit operator approval outside MCP.

## When to stop for the operator

Stop and ask rather than guessing when:

- A claim is refused, expired, or owned by another agent
- Subject context is missing, ambiguous, or points at archived records
- Completing would require provider publish or Drive mutation
- Evidence is incomplete and the handoff schema marks fields as required
- Rate limits or scope errors appear — do not retry in a tight loop
- Queue health or publish preview shows blocking alerts you cannot resolve locally

## Diagnostics

- `system_connection_status` — read-only check that auth, tools, and resources respond. Safe to run
  any time; it creates no handoff and writes nothing.
- The operator's Settings diagnostic runs the same checks from the server side.

## Optional: Claude Code background inbox loop

Claude Code operators may opt into a **client-side** pattern that does not require HCC server
changes:

1. Schedule a wakeup or cron-triggered session.
2. Poll `hcc://coordination/inbox` for `OPEN` handoffs directed at this agent's label.
3. Spawn a subagent per handoff via the `Agent` tool.
4. Complete through `coordination_complete_handoff` with the same evidence rules as above.

HCC's `agent_handoffs` queue remains authoritative — this loop is a convenience bridge, not a
second source of truth. Do not enable it unless the operator explicitly wants autonomous pickup.

## Skill packages

| Platform | Wrapper location |
| --- | --- |
| Cursor | `.cursor/skills/hybrid-command-center/SKILL.md` |
| Claude Code | `.claude/skills/hybrid-command-center/SKILL.md` |
| Codex | `.codex-plugin/` plugin with bundled skill |

Each wrapper links to this document and adds only platform-specific packaging instructions.

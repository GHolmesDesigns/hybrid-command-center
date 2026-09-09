---
name: hybrid-command-center
description: >-
  Connect to Hybrid Command Center over MCP and follow the claim → work → prove
  coordination loop. Use when working HCC handoffs, the coordination inbox, Signal
  queue reads, or workspace context through MCP.
---

# Hybrid Command Center (Claude Code)

Read the canonical workflow policy before taking handoffs:

**[docs/mcp-agent-workflow.md](../../docs/mcp-agent-workflow.md)**

That document covers connection, the claim → work → prove loop, approval boundaries, when to stop for
the operator, and which MCP prompts to use. This file adds only Claude Code-specific packaging.

## Connect in Claude Code

1. Ask the operator to run **Agents → Agent connection setup** in HCC, issue a credential for
   your label, and copy the generated configuration.
2. For local development, commit `.mcp.json` at the repository root with your label in
   `MCP_AGENT_LABEL`. Start Claude Code from the repository root so `${CLAUDE_PROJECT_DIR:-.}`
   resolves correctly.
3. For hosted network MCP, paste the HTTPS configuration into Claude Code MCP settings. Never commit
   the bearer.
4. Reload MCP servers after saving.

**Coordination writes must use HTTPS prod**, not local stdio — see
[docs/mcp-agent-workflow.md](../../docs/mcp-agent-workflow.md) §Connect once. Run
`system_connection_status` on both connections and compare `storeId` before posting handoffs.

## MCP prompts

Operational reads and writes are exposed as `agent_health_dashboard`, `agent_get_presence`,
`agent_set_presence`, `agent_list_presence`, `agent_list_summaries`, `agent_list_notifications`,
`agent_create_notification`, and `agent_mark_notification_read`.

After connecting, fetch workflow prompts with `prompts/list` and `prompts/get`. Start with
`start_claimed_work` when you have a handoff ID, and `verify_before_complete` before finishing.

## Optional background inbox loop (operator opt-in)

If the operator wants autonomous handoff pickup, see the **Optional: Claude Code background inbox
loop** section in the canonical workflow document. That pattern polls the inbox and spawns subagents
client-side — HCC adds no server scheduler. Enable it only when the operator explicitly requests it.

## Discovery

This skill is discoverable via Claude Code's `Skill` tool from `.claude/skills/hybrid-command-center/`.

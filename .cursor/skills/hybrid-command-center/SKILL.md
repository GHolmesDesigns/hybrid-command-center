---
name: hybrid-command-center
description: >-
  Connect to Hybrid Command Center over MCP and follow the claim → work → prove
  coordination loop. Use when working HCC handoffs, the coordination inbox, Signal
  queue reads, or workspace context through MCP.
---

# Hybrid Command Center (Cursor)

Read the canonical workflow policy before taking handoffs:

**[docs/mcp-agent-workflow.md](../../docs/mcp-agent-workflow.md)**

That document covers connection, the claim → work → prove loop, approval boundaries, when to stop for
the operator, and which MCP prompts to use. This file adds only Cursor-specific packaging.

## Connect in Cursor

1. Ask the operator to run **Agents → Agent connection setup** in HCC, issue a credential for
   your label, and copy the generated configuration.
2. For local development, commit `.cursor/mcp.json` with your label in `MCP_AGENT_LABEL` — no
   bearer is stored in tracked files for stdio transport.
3. For hosted network MCP, paste the HTTPS configuration into Cursor's MCP settings or local secret
   storage. Never commit the bearer.
4. Reload MCP servers in Cursor after saving.

**Coordination writes must use HTTPS prod**, not local stdio — see
[docs/mcp-agent-workflow.md](../../docs/mcp-agent-workflow.md) §Connect once. Run
`system_connection_status` on both connections and compare `storeId` before posting handoffs.

## MCP prompts

After connecting, fetch workflow prompts with `prompts/list` and `prompts/get`. Start with
`start_claimed_work` when you have a handoff ID, and `verify_before_complete` before finishing.

## Discovery

This skill lives at `.cursor/skills/hybrid-command-center/`. Cursor surfaces it alongside other
project skills when coordination or HCC work is in scope.

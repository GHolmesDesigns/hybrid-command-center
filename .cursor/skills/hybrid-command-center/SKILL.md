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

Then read the Cursor surface guide — it covers IDE Agent vs Cloud Agent, store identity, shell
bypass, and efficiency patterns the workflow doc does not restate:

**[docs/mcp-cursor-agent-guide.md](../../docs/mcp-cursor-agent-guide.md)**

That pair covers connection, the claim → work → prove loop, approval boundaries, when to stop for
the operator, MCP prompts, and which Cursor contexts share (or silently split) the same API.

## Connect in Cursor

1. Ask the operator to run **Agents → Agent connection setup** in HCC, issue a credential for
   your label, and copy the generated configuration.
2. Open **Cursor Settings → MCP** (or **Tools & MCP**). Paste the ready-to-paste setup from
   Agents. Never commit the bearer.
3. Reload MCP servers after saving.
4. Call `system_connection_status` and confirm `agentLabel` and `storeId` before coordination
   writes.

**Coordination writes must use HTTPS prod**, not local stdio and not shell/localhost API — see
[docs/mcp-cursor-agent-guide.md](../../docs/mcp-cursor-agent-guide.md) §2–3. Issue separate
labels for IDE and Cloud Agent (`cursor-ide`, `cursor-cloud`, …) when both act independently.

## MCP prompts

After connecting, fetch workflow prompts with `prompts/list` and `prompts/get`. Start with
`start_claimed_work` when you have a handoff ID, and `verify_before_complete` before finishing.

## Discovery

This skill lives at `.cursor/skills/hybrid-command-center/`. Cursor surfaces it alongside other
project skills when coordination or HCC work is in scope.

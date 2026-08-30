---
name: hybrid-command-center
description: >-
  Connect to Hybrid Command Center over MCP and follow the claim → work → prove
  coordination loop. Use when working HCC handoffs, the coordination inbox, Signal
  queue reads, or workspace context through MCP.
---

# Hybrid Command Center (Codex)

Read the canonical workflow policy before taking handoffs:

**[docs/mcp-agent-workflow.md](../../docs/mcp-agent-workflow.md)**

That document covers connection, the claim → work → prove loop, approval boundaries, when to stop for
the operator, and which MCP prompts to use. This file adds only Codex-specific packaging.

## Connect in Codex

1. Ask the operator to run **Agents → Agent connection setup** in HCC, issue a credential for
   your label, and copy the generated configuration.
2. For local stdio, paste the TOML snippet into `~/.codex/config.toml`. Codex has no project
   context — use the absolute repository path the operator provides. That file is machine-local and
   never committed.
3. For hosted network MCP, paste the HTTPS JSON into Codex MCP configuration. Never commit the
   bearer.
4. Restart Codex after saving.

## MCP prompts

After connecting, fetch workflow prompts with `prompts/list` and `prompts/get`. Start with
`start_claimed_work` when you have a handoff ID, and `verify_before_complete` before finishing.

## Plugin install

This skill ships with the repository's `.codex-plugin/` manifest. Install or enable the plugin in
Codex, then configure the MCP server separately using the guided connection flow in HCC Settings.

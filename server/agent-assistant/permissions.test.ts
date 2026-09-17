import { describe, expect, it } from 'vitest';
import { MCP_TOOL_REGISTRY, mcpToolAvailable } from '../mcp/registry.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import { ASSISTANT_DEFAULT_SCOPES } from '../../shared/mcp-agent-registry.ts';

const assistantToolAvailable = (toolName: string, scopes: readonly McpAgentScope[]) => {
  const entry = MCP_TOOL_REGISTRY.find((tool) => tool.name === toolName);
  if (!entry) return false;
  return mcpToolAvailable(entry, scopes);
};

describe('assistant vs MCP permission matrix', () => {
  it('matches MCP scope checks for default assistant scopes', () => {
    for (const entry of MCP_TOOL_REGISTRY) {
      const mcpAllowed = mcpToolAvailable(entry, ASSISTANT_DEFAULT_SCOPES);
      const assistantAllowed = assistantToolAvailable(entry.name, ASSISTANT_DEFAULT_SCOPES);
      expect(assistantAllowed).toBe(mcpAllowed);
    }
  });

  it('refuses tools outside granted scopes', () => {
    expect(assistantToolAvailable('settings_update_branding', ['workspace:read'])).toBe(false);
    expect(assistantToolAvailable('workspace_list_tasks', ['workspace:read'])).toBe(true);
    expect(assistantToolAvailable('drive_request_write', ['workspace:read'])).toBe(false);
    expect(assistantToolAvailable('drive_request_write', ['drive:write-request'])).toBe(true);
  });
});

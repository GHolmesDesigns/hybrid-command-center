import { describe, expect, it } from 'vitest';
import {
  isCoordinationTool,
  isRegisteredMcpTool,
  mcpToolAvailable,
  mcpToolRegistryEntry,
  mcpToolsListPayload,
  workspaceContextFiltersFromToolArgs,
} from './registry.ts';

describe('mcp tool registry', () => {
  it('lists every registered tool for tools/list', () => {
    const names = mcpToolsListPayload().map((tool) => tool.name);
    expect(names).toContain('system_capabilities');
    expect(names).toContain('coordination_list_handoffs');
    expect(isRegisteredMcpTool('system_capabilities')).toBe(true);
    expect(isRegisteredMcpTool('not_a_tool')).toBe(false);
  });

  it('recognises coordination tools and resolves registry entries', () => {
    expect(isCoordinationTool('coordination_claim_handoff')).toBe(true);
    expect(isCoordinationTool('system_capabilities')).toBe(false);
    expect(mcpToolRegistryEntry('coordination_get_handoff')?.requiredScope).toBe(
      'coordination:read',
    );
    expect(mcpToolRegistryEntry('missing')).toBeUndefined();
  });

  it('marks availability from granted scopes and meta tools', () => {
    const writeTool = mcpToolRegistryEntry('coordination_post_handoff')!;
    const metaTool = mcpToolRegistryEntry('system_capabilities')!;
    expect(mcpToolAvailable(writeTool, ['coordination:read'])).toBe(false);
    expect(mcpToolAvailable(writeTool, ['coordination:write'])).toBe(true);
    expect(mcpToolAvailable(metaTool, [])).toBe(true);
  });

  it('maps system_capabilities tool args to workspace filters', () => {
    expect(workspaceContextFiltersFromToolArgs(null)).toEqual({});
    expect(workspaceContextFiltersFromToolArgs({})).toEqual({});
    expect(
      workspaceContextFiltersFromToolArgs({
        sections: ['workspace'],
        include: ['clients'],
      }),
    ).toEqual({
      sections: ['workspace'],
      include: ['clients'],
    });
    expect(workspaceContextFiltersFromToolArgs({ sections: [] })).toEqual({});
  });
});

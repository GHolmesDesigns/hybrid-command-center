import { describe, expect, it } from 'vitest';
import {
  isCoordinationTool,
  isRegisteredMcpTool,
  mcpToolAvailable,
  mcpToolRegistryEntry,
  mcpToolsListPayload,
  MCP_TOOL_REGISTRY,
  workspaceContextFiltersFromToolArgs,
} from './registry.ts';

describe('mcp tool registry', () => {
  it('lists every registered tool for tools/list', () => {
    const names = mcpToolsListPayload().map((tool) => tool.name);
    expect(names).toContain('system_capabilities');
    expect(names).toContain('coordination_list_handoffs');
    expect(names).toContain('workspace_dashboard_summary');
    expect(names).toContain('signal_queue_health');
    expect(names).toContain('signal_create_post');
    expect(names).toContain('workspace_create_task');
    expect(names).toContain('workspace_merge_clients_preview');
    expect(names).toContain('drive_sync');
    expect(names).toContain('drive_request_write');
    expect(names).toContain('files_browse_project');
    expect(names).toContain('agent_health_dashboard');
    expect(names).toContain('agent_set_presence');
    expect(names).toContain('agent_list_notifications');
    expect(
      names.filter((name) => name !== 'system_capabilities' && name !== 'system_connection_status'),
    ).toHaveLength(69);
    expect(names).toContain('system_connection_status');
    expect(isRegisteredMcpTool('system_capabilities')).toBe(true);
    expect(isRegisteredMcpTool('not_a_tool')).toBe(false);
  });

  it('exposes no provider-write or permanent-client-delete tools', () => {
    const names = new Set(mcpToolsListPayload().map((tool) => tool.name));
    for (const forbidden of [
      'signal_publish_submit',
      'signal_publish_now',
      'signal_provider_apply',
      'signal_provider_reconcile',
      'signal_buffer_target_apply',
      'signal_publication_finish',
      'workspace_delete_client',
      'workspace_destroy_client',
    ]) {
      expect(names.has(forbidden)).toBe(false);
    }
    for (const entry of [
      mcpToolRegistryEntry('signal_create_post'),
      mcpToolRegistryEntry('workspace_create_task'),
    ]) {
      expect(entry?.class).toBe('L');
      expect(entry?.requiredScope).toBe('workspace:write');
      expect(entry?.handler).toBe('workspace_write');
    }
    expect(MCP_TOOL_REGISTRY.some((tool) => tool.class === 'P')).toBe(false);
    for (const name of [
      'import_signal_commit',
      'signal_resolve_drive_media',
      'signal_resolve_drive_media_batch',
      'drive_sync',
      'signal_refresh_provider_inventory',
    ] as const) {
      const entry = mcpToolRegistryEntry(name);
      expect(entry?.class).toBe('I');
      expect(entry?.handler).toBe('integration_write');
      expect(entry?.requiredScope).toBe('workspace:write');
    }
    expect(mcpToolRegistryEntry('files_browse_project')).toMatchObject({
      class: 'R',
      requiredScope: 'workspace:read',
      handler: 'integration_read',
    });
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
    const readTool = mcpToolRegistryEntry('workspace_dashboard_summary')!;
    const metaTool = mcpToolRegistryEntry('system_capabilities')!;
    expect(mcpToolAvailable(writeTool, ['coordination:read'])).toBe(false);
    expect(mcpToolAvailable(writeTool, ['coordination:write'])).toBe(true);
    expect(mcpToolAvailable(readTool, ['coordination:read'])).toBe(false);
    expect(mcpToolAvailable(readTool, ['workspace:read'])).toBe(true);
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

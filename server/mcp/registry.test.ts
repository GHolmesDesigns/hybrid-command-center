import { describe, expect, it } from 'vitest';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import {
  isCoordinationTool,
  isRegisteredMcpTool,
  mcpToolAvailable,
  mcpToolRegistryEntry,
  mcpToolsListPayload,
  MCP_TOOL_REGISTRY,
  workspaceContextFiltersFromToolArgs,
} from './registry.ts';

const SIGNAL_WRITE_TOOLS = [
  'signal_create_post',
  'signal_update_post',
  'signal_set_slot',
  'signal_update_variants',
  'signal_update_publish_targets',
  'signal_assign_posts',
  'signal_duplicate_post',
  'signal_ack_alert',
  'signal_resolve_drive_media',
  'signal_resolve_drive_media_batch',
  'signal_recheck_post_media',
  'signal_recheck_variant_media',
  'signal_refresh_provider_inventory',
  'signal_refresh_analytics_window',
  'signal_refresh_buffer_accounts',
] as const;

const expectedRequiredScope = (name: string): McpAgentScope | null => {
  if (name === 'system_capabilities' || name === 'system_connection_status') return null;
  if (name === 'drive_request_write') return 'drive:write-request';
  if (name.startsWith('coordination_') || name.startsWith('work_')) {
    return name.includes('list') ||
      name.includes('get') ||
      name === 'work_get_resume_context' ||
      name === 'coordination_get_handoff'
      ? 'coordination:read'
      : 'coordination:write';
  }
  if (name === 'settings_update_branding' || name === 'settings_update_view_defaults') {
    return 'settings:write';
  }
  if (name === 'import_playbook_commit' || name === 'import_signal_commit') return 'import:write';
  if (name === 'drive_sync') return 'drive:sync';
  if ((SIGNAL_WRITE_TOOLS as readonly string[]).includes(name)) return 'signal:write';
  if (
    name.startsWith('workspace_') &&
    !name.endsWith('_preview') &&
    name !== 'workspace_dashboard_summary' &&
    name !== 'workspace_list_tasks' &&
    name !== 'workspace_get_subject_context' &&
    name !== 'workspace_search'
  ) {
    return 'workspace:write';
  }
  if (
    name.startsWith('signal_') ||
    name.startsWith('workspace_') ||
    name.startsWith('import_') ||
    name === 'files_browse_project' ||
    name === 'integration_list_activity'
  ) {
    return 'workspace:read';
  }
  if (name.startsWith('conversation_') || name.startsWith('agent_') || name.startsWith('memory_')) {
    const entry = mcpToolRegistryEntry(name);
    return entry?.class === 'L' ? 'workspace:write' : 'workspace:read';
  }
  throw new Error(`Add expectedRequiredScope rule for ${name}`);
};

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
    expect(names).toContain('agent_list_directory');
    expect(names).toContain('agent_list_notifications');
    expect(
      names.filter((name) => name !== 'system_capabilities' && name !== 'system_connection_status'),
    ).toHaveLength(84);
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
    expect(mcpToolRegistryEntry('signal_create_post')).toMatchObject({
      class: 'L',
      requiredScope: 'signal:write',
      handler: 'workspace_write',
    });
    expect(mcpToolRegistryEntry('workspace_create_task')).toMatchObject({
      class: 'L',
      requiredScope: 'workspace:write',
      handler: 'workspace_write',
    });
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
      if (name === 'import_signal_commit') expect(entry?.requiredScope).toBe('import:write');
      else if (name === 'drive_sync') expect(entry?.requiredScope).toBe('drive:sync');
      else expect(entry?.requiredScope).toBe('signal:write');
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

  it('assigns every registered tool the expected requiredScope', () => {
    for (const tool of MCP_TOOL_REGISTRY) {
      expect(tool.requiredScope).toBe(expectedRequiredScope(tool.name));
    }
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

import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { MockDriveProvider } from '../drive/mock-provider.ts';
import { callMcpTool } from './dispatch.ts';
import { createMcpSession } from './session.ts';
import { MCP_TOOL_REGISTRY, mcpToolsListPayload } from './registry.ts';
import {
  COORDINATION_READ_TOOLS,
  COORDINATION_WRITE_TOOLS,
} from '../../shared/mcp-agent-events.ts';

const NOW = new Date('2026-08-11T12:00:00.000Z');

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('callMcpTool', () => {
  it('lists thirteen coordination and workspace read tools plus system_capabilities', () => {
    const names = mcpToolsListPayload().map((tool) => tool.name);
    expect(names).toHaveLength(MCP_TOOL_REGISTRY.length);
    expect(
      names.filter((name) => name !== 'system_capabilities' && name !== 'system_connection_status'),
    ).toHaveLength(MCP_TOOL_REGISTRY.length - 2);
    for (const tool of [...COORDINATION_READ_TOOLS, ...COORDINATION_WRITE_TOOLS]) {
      expect(names).toContain(tool);
    }
    expect(names).toContain('workspace_dashboard_summary');
    expect(names).toContain('signal_publish_preview');
  });

  it('refuses workspace reads without workspace:read scope', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const result = await callMcpTool(
      db,
      session,
      'workspace_dashboard_summary',
      {},
      {
        grantedScopes: ['coordination:read'],
        now: NOW,
      },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('WORKSPACE_SCOPE_REQUIRED');
  });

  it('routes system_capabilities through the registry handler', async () => {
    const session = createMcpSession();
    const result = await callMcpTool(
      db,
      session,
      'system_capabilities',
      { sections: ['tools'] },
      {
        grantedScopes: ['coordination:read'],
        now: NOW,
      },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect((result.data as { tools?: unknown[] }).tools?.length).toBeGreaterThan(0);
  });

  it('preserves coordination read behaviour through the async dispatcher', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const result = await callMcpTool(
      db,
      session,
      'coordination_list_handoffs',
      {},
      {
        grantedScopes: ['coordination:read'],
        now: NOW,
      },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect(result.data).toEqual({ handoffs: [], limit: 50, offset: 0, truncated: false });
  });

  it('refuses unknown tools and coordination writes without write scope', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const unknown = await callMcpTool(
      db,
      session,
      'not_registered',
      {},
      {
        grantedScopes: ['workspace:read'],
        now: NOW,
      },
    );
    expect(unknown.outcome).toBe('FAILURE');
    expect(unknown.errorDetail?.code).toBe('COORDINATION_UNKNOWN_TOOL');

    const write = await callMcpTool(
      db,
      session,
      'coordination_post_handoff',
      { subjectType: 'freeform', message: 'Needs write scope.' },
      {
        grantedScopes: ['coordination:read'],
        now: NOW,
      },
    );
    expect(write.outcome).toBe('REFUSED');
    expect(write.errorDetail?.code).toBe('COORDINATION_SCOPE_REQUIRED');
  });

  it('routes workspace reads when workspace:read is granted', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const result = await callMcpTool(
      db,
      session,
      'workspace_dashboard_summary',
      {},
      {
        grantedScopes: ['workspace:read'],
        now: NOW,
      },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect((result.data as { counts: unknown }).counts).toBeDefined();
  });

  it('routes integration read and write tools when workspace scopes are granted', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const read = await callMcpTool(
      db,
      session,
      'integration_list_activity',
      { limit: 1 },
      {
        grantedScopes: ['workspace:read'],
        now: NOW,
      },
    );
    expect(read.outcome).toBe('SUCCESS');
    expect(Array.isArray(read.data)).toBe(true);

    const drive = new MockDriveProvider();
    drive.connected = false;
    const write = await callMcpTool(
      db,
      session,
      'drive_sync',
      { clientRequestId: 'dispatch-drive-sync' },
      {
        grantedScopes: ['workspace:write'],
        now: NOW,
        integrationDeps: { drive },
      },
    );
    expect(write.outcome).toBe('SUCCESS');
  });
});

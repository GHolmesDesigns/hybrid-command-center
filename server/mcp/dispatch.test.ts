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
  it('provides memory suggest, review, approval, correction, archive, and delete parity', async () => {
    const session = createMcpSession({ agentLabel: 'memory-agent' });
    const options = { grantedScopes: ['workspace:read', 'workspace:write'] as const, now: NOW };
    const suggested = await callMcpTool(
      db,
      session,
      'memory_suggest',
      {
        key: 'release-process',
        value: 'Run gates.',
        scope: { type: 'workspace' },
        source: 'test',
      },
      options,
    );
    expect(suggested.outcome).toBe('SUCCESS');
    const id = (suggested.data as { id: string }).id;
    expect(
      (await callMcpTool(db, session, 'memory_list', { state: 'SUGGESTED' }, options)).data,
    ).toMatchObject({ memories: [{ id }] });
    expect((await callMcpTool(db, session, 'memory_get', { id }, options)).data).toMatchObject({
      id,
      state: 'SUGGESTED',
    });
    expect((await callMcpTool(db, session, 'memory_approve', { id }, options)).data).toMatchObject({
      id,
      state: 'APPROVED',
    });
    const corrected = await callMcpTool(
      db,
      session,
      'memory_suggest',
      {
        key: 'correct',
        value: 'old',
        scope: { type: 'workspace' },
        source: 'test',
      },
      options,
    );
    const secondId = (corrected.data as { id: string }).id;
    expect(
      (await callMcpTool(db, session, 'memory_correct', { id: secondId, value: 'new' }, options))
        .data,
    ).toMatchObject({ id: secondId, value: 'new', state: 'APPROVED' });
    expect(
      (await callMcpTool(db, session, 'memory_archive', { id: secondId }, options)).data,
    ).toMatchObject({ state: 'ARCHIVED' });
    expect(
      (await callMcpTool(db, session, 'memory_delete', { id: secondId }, options)).data,
    ).toEqual({ ok: true });
  });
  it('provides conversation parity for an authenticated agent', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const options = { grantedScopes: ['workspace:read', 'workspace:write'] as const, now: NOW };
    const created = await callMcpTool(
      db,
      session,
      'conversation_create',
      {
        title: 'Parity',
        scope: { type: 'freeform' },
      },
      options,
    );
    expect(created.outcome).toBe('SUCCESS');
    const id = (created.data as { id: string }).id;
    expect(
      (await callMcpTool(db, session, 'conversation_post_message', { id, body: 'Hello' }, options))
        .outcome,
    ).toBe('SUCCESS');
    expect(
      (await callMcpTool(db, session, 'conversation_get', { id }, options)).data,
    ).toMatchObject({ id, messageCount: 1 });
    expect((await callMcpTool(db, session, 'conversation_list', {}, options)).outcome).toBe(
      'SUCCESS',
    );
    expect(
      (
        await callMcpTool(
          db,
          session,
          'conversation_list_messages',
          { id, direction: 'before' },
          options,
        )
      ).data,
    ).toMatchObject({ items: [{ body: 'Hello', provenance: 'ASSERTED' }] });
    expect((await callMcpTool(db, session, 'conversation_archive', { id }, options)).outcome).toBe(
      'SUCCESS',
    );
  });
  it('routes agent health, session presence, summaries, and notifications through existing services', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const options = {
      grantedScopes: ['workspace:read', 'workspace:write'] as const,
      now: NOW,
      authRequired: false,
    };
    expect((await callMcpTool(db, session, 'agent_health_dashboard', {}, options)).outcome).toBe(
      'SUCCESS',
    );
    expect(
      (await callMcpTool(db, session, 'agent_set_presence', { state: 'BUSY' }, options)).outcome,
    ).toBe('SUCCESS');
    expect((await callMcpTool(db, session, 'agent_get_presence', {}, options)).data).toMatchObject({
      agentLabel: 'cursor',
      state: 'BUSY',
    });
    expect(
      (await callMcpTool(db, session, 'agent_list_presence', { limit: 1 }, options)).outcome,
    ).toBe('SUCCESS');
    expect(
      (await callMcpTool(db, session, 'agent_list_summaries', { agentLabel: 'cursor' }, options))
        .outcome,
    ).toBe('SUCCESS');
    const created = await callMcpTool(
      db,
      session,
      'agent_create_notification',
      {
        incidentKey: 'test-577',
        kind: 'test',
        agentLabel: 'cursor',
        title: 'Test',
        body: 'Check in',
      },
      options,
    );
    expect(created.outcome).toBe('SUCCESS');
    const id = (created.data as { id: string }).id;
    expect(
      (await callMcpTool(db, session, 'agent_list_notifications', { unreadOnly: true }, options))
        .outcome,
    ).toBe('SUCCESS');
    expect(
      (await callMcpTool(db, session, 'agent_mark_notification_read', { id }, options)).outcome,
    ).toBe('SUCCESS');
  });

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

import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { buildConnectionStatus } from './connection-status.ts';
import { callMcpTool } from './dispatch.ts';
import { createMcpSession } from './session.ts';
import { workspaceDataChecksum } from './workspace-checksum.ts';
import { MCP_AGENT_SCOPES } from '../../shared/mcp-agent-registry.ts';
import { postHandoff } from '../agent-coordination/service.ts';

const NOW = new Date('2026-08-28T12:00:00.000Z');

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('buildConnectionStatus', () => {
  it('returns a successful diagnostic without workspace writes', () => {
    const before = workspaceDataChecksum(db);
    const status = buildConnectionStatus(db, {
      transport: 'http',
      authenticated: true,
      agentLabel: 'cursor-planning',
      grantedScopes: MCP_AGENT_SCOPES,
      now: NOW,
    });
    const after = workspaceDataChecksum(db);
    expect(before).toBe(after);
    expect(status.ok).toBe(true);
    expect(status.checks.toolsList.ok).toBe(true);
    expect(status.checks.resourcesList.ok).toBe(true);
    expect(status.checks.resourceRead.ok).toBe(true);
    expect(status.capabilityVersion).toMatch(/^mcp-/);
  });

  it('reports failure when the caller is not authenticated', () => {
    const status = buildConnectionStatus(db, {
      transport: 'operator',
      authenticated: false,
      agentLabel: null,
      grantedScopes: [],
      now: NOW,
    });
    expect(status.ok).toBe(false);
    expect(status.authenticated).toBe(false);
  });
});

describe('system_connection_status tool', () => {
  it('does not mutate workspace tables when invoked through dispatch', async () => {
    postHandoff(
      db,
      {
        fromAgentLabel: 'poster',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'Existing handoff',
      },
      NOW,
    );
    const before = workspaceDataChecksum(db);
    const session = createMcpSession({ agentLabel: 'cursor' });
    const result = await callMcpTool(
      db,
      session,
      'system_connection_status',
      {},
      {
        grantedScopes: MCP_AGENT_SCOPES,
        now: NOW,
        transport: 'stdio',
        authenticated: true,
      },
    );
    const after = workspaceDataChecksum(db);
    expect(before).toBe(after);
    expect(result.outcome).toBe('SUCCESS');
    expect((result.data as { ok: boolean }).ok).toBe(true);
  });
});

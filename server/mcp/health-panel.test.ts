import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { buildMcpHealthPanel } from './health-panel.ts';
import { recordMcpAgentEvent } from './events.ts';
import { createMcpAgentCredential } from '../auth/mcp-agent-credentials.ts';
import { postHandoff } from '../agent-coordination/service.ts';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const SECRET = 'test-session-secret-at-least-32-chars!';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('buildMcpHealthPanel', () => {
  it('reports never connected when the registry and audit are empty', () => {
    const panel = buildMcpHealthPanel(db, { enabled: true, now: NOW });
    expect(panel.state).toBe('never_connected');
    expect(panel.agents).toEqual([]);
  });

  it('aggregates per-agent success and failure timestamps', () => {
    createMcpAgentCredential(db, {
      label: 'cursor-planning',
      scopes: ['coordination:read', 'coordination:write'],
      expiresAt: '2026-12-01T00:00:00.000Z',
      sessionSecret: SECRET,
      now: NOW.getTime(),
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'cursor-planning',
      tool: 'coordination_list_handoffs',
      outcome: 'SUCCESS',
      summary: 'coordination_list_handoffs succeeded.',
      at: '2026-08-28T11:00:00.000Z',
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'cursor-planning',
      tool: 'coordination_post_handoff',
      outcome: 'REFUSED',
      summary: 'Coordination write rate limit exceeded.',
      at: '2026-08-28T12:00:00.000Z',
    });
    const panel = buildMcpHealthPanel(db, { enabled: true, now: NOW });
    expect(panel.state).toBe('mixed');
    expect(panel.agents).toEqual([
      expect.objectContaining({
        label: 'cursor-planning',
        requestCount: 2,
        refusalCount: 1,
        rateLimitCount: 1,
        lastSuccessAt: '2026-08-28T11:00:00.000Z',
        lastFailureAt: '2026-08-28T12:00:00.000Z',
      }),
    ]);
    expect(panel.errorSummary).toEqual([
      expect.objectContaining({ code: 'COORDINATION_RATE_LIMIT_EXCEEDED', count: 1 }),
    ]);
  });

  it('surfaces stale OPEN and long-running CLAIMED handoffs', () => {
    postHandoff(
      db,
      {
        fromAgentLabel: 'poster',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'Old open handoff',
      },
      new Date('2026-06-01T00:00:00.000Z'),
    );
    const claimed = postHandoff(
      db,
      {
        fromAgentLabel: 'poster',
        toAgentLabel: 'cursor',
        subjectType: 'freeform',
        subjectId: null,
        message: 'Stuck claim',
      },
      new Date('2026-06-15T00:00:00.000Z'),
    );
    db.prepare(
      `UPDATE agent_handoffs SET state='CLAIMED', claimed_by='cursor', claimed_at=?, updated_at=? WHERE id=?`,
    ).run('2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z', claimed.id);

    const panel = buildMcpHealthPanel(db, { enabled: true, now: NOW });
    expect(panel.staleHandoffs.length).toBe(2);
    expect(panel.staleHandoffs.map((row) => row.reason).sort()).toEqual([
      'claimed_age',
      'open_ttl',
    ]);
  });

  it('includes audit-only agent labels that are not in the registry', () => {
    recordMcpAgentEvent(db, {
      agentLabel: 'stdio-only',
      tool: 'coordination_list_handoffs',
      outcome: 'FAILURE',
      summary: 'Unknown tool: foo.',
      at: '2026-08-28T12:00:00.000Z',
    });
    const panel = buildMcpHealthPanel(db, { enabled: true, now: NOW });
    expect(panel.agents).toEqual([
      expect.objectContaining({
        label: 'stdio-only',
        requestCount: 1,
        failureCount: 1,
        lastFailureAt: '2026-08-28T12:00:00.000Z',
      }),
    ]);
  });

  it('degrades when the audit table cannot be read', async () => {
    const eventsModule = await import('./events.ts');
    vi.spyOn(eventsModule, 'listMcpAgentEvents').mockImplementation(() => {
      throw new Error('database locked');
    });
    const panel = buildMcpHealthPanel(db, { enabled: true, now: NOW });
    expect(panel.state).toBe('unavailable');
    vi.restoreAllMocks();
  });

  it('omits registry rows when operator auth is disabled', () => {
    createMcpAgentCredential(db, {
      label: 'cursor-planning',
      scopes: ['coordination:read'],
      expiresAt: '2026-12-01T00:00:00.000Z',
      sessionSecret: SECRET,
      now: NOW.getTime(),
    });
    const panel = buildMcpHealthPanel(db, { enabled: false, now: NOW });
    expect(panel.enabled).toBe(false);
    expect(panel.agents).toEqual([]);
  });

  it('reports all_failed and healthy states from audit rows', () => {
    createMcpAgentCredential(db, {
      label: 'healthy-agent',
      scopes: ['coordination:read'],
      expiresAt: '2026-12-01T00:00:00.000Z',
      sessionSecret: SECRET,
      now: NOW.getTime(),
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'healthy-agent',
      tool: 'coordination_list_handoffs',
      outcome: 'SUCCESS',
      summary: 'coordination_list_handoffs succeeded.',
      at: '2026-08-28T12:00:00.000Z',
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'failed-agent',
      tool: 'coordination_list_handoffs',
      outcome: 'FAILURE',
      summary: 'Something else entirely.',
      at: '2026-08-28T12:00:00.000Z',
    });
    recordMcpAgentEvent(db, {
      agentLabel: null,
      tool: 'coordination_list_handoffs',
      outcome: 'FAILURE',
      summary: 'Missing agent_label on write.',
      at: '2026-08-28T11:30:00.000Z',
    });
    const panel = buildMcpHealthPanel(db, { enabled: true, now: NOW });
    expect(panel.state).toBe('mixed');
    expect(panel.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'healthy-agent',
          failureCount: 0,
          lastSuccessAt: '2026-08-28T12:00:00.000Z',
        }),
        expect.objectContaining({
          label: 'failed-agent',
          failureCount: 1,
          lastFailureAt: '2026-08-28T12:00:00.000Z',
        }),
      ]),
    );
    expect(panel.errorSummary).toEqual([
      expect.objectContaining({ code: 'COORDINATION_AGENT_LABEL_REQUIRED', count: 1 }),
    ]);
  });

  it('keeps the newest success and failure timestamps per agent', () => {
    recordMcpAgentEvent(db, {
      agentLabel: 'cursor',
      tool: 'coordination_list_handoffs',
      outcome: 'SUCCESS',
      summary: 'coordination_list_handoffs succeeded.',
      at: '2026-08-28T10:00:00.000Z',
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'cursor',
      tool: 'coordination_list_handoffs',
      outcome: 'SUCCESS',
      summary: 'coordination_list_handoffs succeeded.',
      at: '2026-08-28T11:00:00.000Z',
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'cursor',
      tool: 'coordination_post_handoff',
      outcome: 'REFUSED',
      summary: 'Invalid state for complete.',
      at: '2026-08-28T09:00:00.000Z',
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'cursor',
      tool: 'coordination_post_handoff',
      outcome: 'REFUSED',
      summary: 'Invalid state for complete.',
      at: '2026-08-28T12:00:00.000Z',
    });
    const panel = buildMcpHealthPanel(db, { enabled: true, now: NOW });
    expect(panel.agents).toEqual([
      expect.objectContaining({
        label: 'cursor',
        lastSuccessAt: '2026-08-28T11:00:00.000Z',
        lastFailureAt: '2026-08-28T12:00:00.000Z',
        refusalCount: 2,
      }),
    ]);
  });
});

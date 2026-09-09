import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import { buildAppHealth } from './app-health.ts';
import { recordMcpAgentEvent } from './mcp/events.ts';
import { createMcpAgentCredential } from './auth/mcp-agent-credentials.ts';

describe('application health aggregation', () => {
  it('keeps readiness, historical activity, and remote verification distinct', () => {
    const db = createDb(':memory:');
    const result = buildAppHealth(db, {
      authRequired: true,
      now: new Date('2026-09-08T12:00:00.000Z'),
    });
    expect(result.signals.process.state).toBe('healthy');
    expect(result.signals.database.state).toBe('healthy');
    expect(result.signals.agentActivity.label).toBe('Historical agent activity');
    expect(result.signals.remoteAgents.label).toBe('Active remote-agent verification');
    expect(result.signals.agentActivity.checkedAt).toBeNull();
    expect(result.signals.remoteAgents.checkedAt).toBeNull();
    expect(result.overall).toBe('degraded');
    db.close();
  });

  it('reports the database unavailable when the readiness query fails', () => {
    const db = createDb(':memory:');
    db.close();
    const result = buildAppHealth(db, { authRequired: true });
    expect(result.signals.database.state).toBe('unavailable');
    expect(result.overall).toBe('unavailable');
  });

  it('reports historical activity unreadable when remote-agent credentials cannot be read', () => {
    const db = createDb(':memory:');
    db.exec('DROP TABLE agent_credentials');
    const result = buildAppHealth(db, { authRequired: true });
    expect(result.signals.agentActivity.state).toBe('unavailable');
    expect(result.signals.agentActivity.detail).toBe(
      'Historical agent activity could not be read.',
    );
    expect(result.overall).toBe('unavailable');
    db.close();
  });

  it('reports historical activity healthy once an agent has a successful call', () => {
    const db = createDb(':memory:');
    recordMcpAgentEvent(db, {
      agentLabel: 'reviewer',
      tool: 'coordination_list_handoffs',
      outcome: 'SUCCESS',
      summary: 'Listed handoffs.',
      at: '2026-09-08T11:00:00.000Z',
    });
    const result = buildAppHealth(db, {
      authRequired: true,
      now: new Date('2026-09-08T12:00:00.000Z'),
    });
    expect(result.signals.agentActivity.state).toBe('healthy');
    expect(result.signals.agentActivity.detail).toBe('1 historical agent event available.');
    // checkedAt tracks when the panel was generated, not the event's own timestamp.
    expect(result.signals.agentActivity.checkedAt).toBe('2026-09-08T12:00:00.000Z');
    db.close();
  });

  it('keeps historical activity degraded when every audited call failed', () => {
    const db = createDb(':memory:');
    recordMcpAgentEvent(db, {
      agentLabel: 'reviewer',
      tool: 'coordination_list_handoffs',
      outcome: 'FAILURE',
      summary: 'Listing failed.',
    });
    recordMcpAgentEvent(db, {
      agentLabel: 'reviewer',
      tool: 'coordination_list_handoffs',
      outcome: 'FAILURE',
      summary: 'Listing failed again.',
    });
    const result = buildAppHealth(db, { authRequired: true });
    expect(result.signals.agentActivity.state).toBe('degraded');
    expect(result.signals.agentActivity.detail).toBe('2 historical agent events available.');
    db.close();
  });

  it('reports a checked-in remote agent as healthy', () => {
    const db = createDb(':memory:');
    const { credential } = createMcpAgentCredential(db, {
      label: 'cursor-planning',
      scopes: ['coordination:read'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      sessionSecret: 'test-secret',
      now: Date.parse('2026-09-08T10:00:00.000Z'),
    });
    db.prepare('UPDATE agent_credentials SET last_used_at=? WHERE id=?').run(
      '2026-09-08T11:30:00.000Z',
      credential.id,
    );
    const result = buildAppHealth(db, {
      authRequired: true,
      now: new Date('2026-09-08T12:00:00.000Z'),
    });
    expect(result.signals.remoteAgents.state).toBe('healthy');
    expect(result.signals.remoteAgents.detail).toBe('1 registered remote agent has checked in.');
    expect(result.signals.remoteAgents.checkedAt).toBe('2026-09-08T11:30:00.000Z');
    db.close();
  });

  it('does not check remote-agent credentials when auth is not required', () => {
    const db = createDb(':memory:');
    const { credential } = createMcpAgentCredential(db, {
      label: 'cursor-planning',
      scopes: ['coordination:read'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      sessionSecret: 'test-secret',
    });
    db.prepare('UPDATE agent_credentials SET last_used_at=? WHERE id=?').run(
      '2026-09-08T11:30:00.000Z',
      credential.id,
    );
    const result = buildAppHealth(db, { authRequired: false });
    expect(result.signals.remoteAgents.state).toBe('degraded');
    db.close();
  });

  it('reports overall healthy once every signal checks out', () => {
    const db = createDb(':memory:');
    recordMcpAgentEvent(db, {
      agentLabel: 'reviewer',
      tool: 'coordination_list_handoffs',
      outcome: 'SUCCESS',
      summary: 'Listed handoffs.',
    });
    const { credential } = createMcpAgentCredential(db, {
      label: 'cursor-planning',
      scopes: ['coordination:read'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      sessionSecret: 'test-secret',
    });
    db.prepare('UPDATE agent_credentials SET last_used_at=? WHERE id=?').run(
      '2026-09-08T11:30:00.000Z',
      credential.id,
    );
    const result = buildAppHealth(db, {
      authRequired: true,
      now: new Date('2026-09-08T12:00:00.000Z'),
    });
    expect(result.overall).toBe('healthy');
    db.close();
  });
});

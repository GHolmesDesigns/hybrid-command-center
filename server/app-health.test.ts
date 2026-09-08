import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import { buildAppHealth } from './app-health.ts';

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
});

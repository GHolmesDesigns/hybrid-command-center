import { describe, expect, it } from 'vitest';
import { createDb } from '../db.ts';
import { postHandoff, claimHandoff } from './service.ts';
import {
  startWorkSession,
  heartbeatWorkSession,
  checkpointWorkSession,
  reclaimableWorkSessions,
  reclaimWorkSession,
  transitionWorkSession,
  releaseWorkSession,
  resumeWorkSession,
} from './work-sessions.ts';

describe('leased work sessions', () => {
  it('records resumable progress and explicitly reopens an expired handoff on reclaim', () => {
    const db = createDb(':memory:');
    const t = new Date('2026-08-28T00:00:00.000Z');
    const handoff = postHandoff(
      db,
      {
        fromAgentLabel: 'planner',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'Do work.',
      },
      t,
    );
    claimHandoff(db, handoff.id, 'agent-a', t);
    const session = startWorkSession(
      db,
      {
        handoffId: handoff.id,
        agentLabel: 'agent-a',
        leaseSeconds: 60,
        baseRevision: 'main',
        currentStep: 'inspect',
      },
      t,
    );
    checkpointWorkSession(
      db,
      session.id,
      'agent-a',
      { currentStep: 'implement', evidence: { changed: ['x'] } },
      t,
    );
    expect(
      heartbeatWorkSession(db, session.id, 'agent-a', 60, new Date('2026-08-28T00:00:10.000Z'))
        .currentStep,
    ).toBe('implement');
    expect(reclaimableWorkSessions(db, new Date('2026-08-28T00:02:00.000Z'))).toHaveLength(1);
    expect(
      reclaimWorkSession(db, session.id, undefined, new Date('2026-08-28T00:02:00.000Z')).state,
    ).toBe('ABANDONED');
    expect(
      (
        db.prepare('SELECT state FROM agent_handoffs WHERE id=?').get(handoff.id) as {
          state: string;
        }
      ).state,
    ).toBe('OPEN');
    db.close();
  });

  it('supports blocked and input transitions, release, and missing-session refusal', () => {
    const db = createDb(':memory:');
    const t = new Date('2026-08-28T00:00:00.000Z');
    const h = postHandoff(
      db,
      {
        fromAgentLabel: 'a',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'x',
      },
      t,
    );
    claimHandoff(db, h.id, 'a', t);
    const s = startWorkSession(
      db,
      { handoffId: h.id, agentLabel: 'a', leaseSeconds: 60, baseRevision: 'r' },
      t,
    );
    expect(transitionWorkSession(db, s.id, 'a', 'NEEDS_INPUT', 'need', t).state).toBe(
      'NEEDS_INPUT',
    );
    expect(transitionWorkSession(db, s.id, 'a', 'BLOCKED', 'blocked', t).state).toBe('BLOCKED');
    expect(releaseWorkSession(db, s.id, 'a', 'stop', t).state).toBe('ABANDONED');
    expect(() => resumeWorkSession(db, 'missing')).toThrow(/not found/);
    db.close();
  });
});

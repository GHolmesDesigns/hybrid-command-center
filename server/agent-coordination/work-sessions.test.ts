import { describe, expect, it } from 'vitest';
import { createDb } from '../db.ts';
import { postHandoff, claimHandoff } from './service.ts';
import { createMcpSession } from '../mcp/session.ts';
import { callCoordinationTool } from '../mcp/coordination.ts';
import { leaseLive, canMutate } from '../domain/agent-work-sessions.ts';
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
    expect(() =>
      startWorkSession(
        db,
        { handoffId: handoff.id, agentLabel: 'agent-a', leaseSeconds: 60, baseRevision: 'main' },
        t,
      ),
    ).toThrow(/live work session/);
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
    expect(() => heartbeatWorkSession(db, s.id, 'other', 60, t)).toThrow(/owner/);
    expect(transitionWorkSession(db, s.id, 'a', 'NEEDS_INPUT', 'need', t).state).toBe(
      'NEEDS_INPUT',
    );
    expect(transitionWorkSession(db, s.id, 'a', 'BLOCKED', 'blocked', t).state).toBe('BLOCKED');
    expect(releaseWorkSession(db, s.id, 'a', 'stop', t).state).toBe('ABANDONED');
    expect(() => releaseWorkSession(db, s.id, 'a', 'again', t)).toThrow(/cannot take/);
    expect(() => reclaimWorkSession(db, s.id, undefined, t)).toThrow(/expired active/);
    expect(() => heartbeatWorkSession(db, s.id, 'a', 60, t)).toThrow(/cannot take/);
    expect(() => resumeWorkSession(db, 'missing')).toThrow(/not found/);
    db.close();
  });

  it('routes every work MCP tool through the coordination dispatcher', () => {
    const db = createDb(':memory:');
    const now = new Date('2026-08-28T00:00:00.000Z');
    const handoff = postHandoff(
      db,
      {
        fromAgentLabel: 'agent',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'dispatch',
      },
      now,
    );
    claimHandoff(db, handoff.id, 'agent', now);
    const session = createMcpSession({ agentLabel: 'agent' });
    const started = callCoordinationTool(
      db,
      session,
      'work_start',
      { handoffId: handoff.id, baseRevision: 'r' },
      now,
    );
    expect(started.outcome).toBe('SUCCESS');
    const id = (started.data as { id: string }).id;
    expect(
      callCoordinationTool(db, session, 'work_heartbeat', { sessionId: id }, now).outcome,
    ).toBe('SUCCESS');
    expect(
      callCoordinationTool(
        db,
        session,
        'work_checkpoint',
        { sessionId: id, currentStep: 'step' },
        now,
      ).outcome,
    ).toBe('SUCCESS');
    expect(
      callCoordinationTool(
        db,
        session,
        'work_request_input',
        { sessionId: id, currentStep: 'ask' },
        now,
      ).outcome,
    ).toBe('SUCCESS');
    expect(
      callCoordinationTool(
        db,
        session,
        'work_mark_blocked',
        { sessionId: id, currentStep: 'blocked' },
        now,
      ).outcome,
    ).toBe('SUCCESS');
    expect(callCoordinationTool(db, session, 'work_complete', { sessionId: id }, now).outcome).toBe(
      'SUCCESS',
    );
    expect(
      callCoordinationTool(db, session, 'work_get_resume_context', { sessionId: id }, now).outcome,
    ).toBe('SUCCESS');
    const second = postHandoff(
      db,
      {
        fromAgentLabel: 'agent',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'release',
      },
      now,
    );
    claimHandoff(db, second.id, 'agent', now);
    const secondStart = callCoordinationTool(
      db,
      session,
      'work_start',
      { handoffId: second.id, baseRevision: 'r' },
      now,
    );
    expect(
      callCoordinationTool(
        db,
        session,
        'work_release',
        { sessionId: (secondStart.data as { id: string }).id, reason: 'done' },
        now,
      ).outcome,
    ).toBe('SUCCESS');
    db.close();
  });

  it('refuses invalid work arguments and missing labels through the shared envelope', () => {
    const db = createDb(':memory:');
    expect(callCoordinationTool(db, createMcpSession(), 'work_start', {}, new Date()).outcome).toBe(
      'REFUSED',
    );
    expect(
      callCoordinationTool(
        db,
        createMcpSession({ agentLabel: 'agent' }),
        'work_start',
        {},
        new Date(),
      ).outcome,
    ).toBe('FAILURE');
    expect(
      callCoordinationTool(
        db,
        createMcpSession({ agentLabel: 'agent' }),
        'not-a-tool',
        {},
        new Date(),
      ).outcome,
    ).toBe('FAILURE');
    db.close();
  });

  it('covers the framework-free lease decisions', () => {
    const now = new Date('2026-08-28T00:00:00.000Z');
    expect(leaseLive({ leaseExpiresAt: '2026-08-28T00:01:00.000Z' }, now)).toBe(true);
    expect(leaseLive({ leaseExpiresAt: '2026-08-27T23:59:00.000Z' }, now)).toBe(false);
    expect(leaseLive({ leaseExpiresAt: null }, now)).toBe(false);
    expect(() => canMutate({ agentLabel: 'a', state: 'COMPLETED' }, 'b', ['COMPLETED'])).toThrow();
    expect(() =>
      canMutate({ agentLabel: 'a', state: 'COMPLETED' }, 'a', ['IN_PROGRESS']),
    ).toThrow();
  });

  it('covers start refusal before a claim and for a missing handoff', () => {
    const db = createDb(':memory:');
    const now = new Date('2026-08-28T00:00:00.000Z');
    const handoff = postHandoff(
      db,
      {
        fromAgentLabel: 'a',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'open',
      },
      now,
    );
    expect(() =>
      startWorkSession(
        db,
        { handoffId: handoff.id, agentLabel: 'a', leaseSeconds: 60, baseRevision: 'r' },
        now,
      ),
    ).toThrow(/CLAIMED/);
    expect(() =>
      startWorkSession(
        db,
        { handoffId: 'missing', agentLabel: 'a', leaseSeconds: 60, baseRevision: 'r' },
        now,
      ),
    ).toThrow(/not found/);
    db.close();
  });
});

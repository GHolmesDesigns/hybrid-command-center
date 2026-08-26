import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { AgentCoordinationError } from '../domain/agent-coordination.ts';
import {
  addHandoffNote,
  cancelHandoffAsAgent,
  cancelHandoffAsOperator,
  claimHandoff,
  completeHandoff,
  getHandoff,
  listHandoffs,
  postHandoff,
} from './service.ts';

let db: Db;
const NOW = new Date('2026-08-26T15:00:00.000Z');

beforeEach(() => {
  db = createDb(':memory:');
});

const post = (overrides: Partial<Parameters<typeof postHandoff>[1]> = {}) =>
  postHandoff(
    db,
    {
      fromAgentLabel: 'cursor',
      subjectType: 'freeform',
      message: 'Please review this caption.',
      ...overrides,
    },
    NOW,
  );

describe('postHandoff', () => {
  it('creates an OPEN handoff and honours client_request_id idempotency', () => {
    const first = post({ clientRequestId: 'req-1' });
    expect(first).toMatchObject({
      state: 'OPEN',
      fromAgentLabel: 'cursor',
      toAgentLabel: null,
      clientRequestId: 'req-1',
    });
    const second = post({
      clientRequestId: 'req-1',
      message: 'Different text that must not insert.',
    });
    expect(second.id).toBe(first.id);
    expect(second.message).toBe(first.message);
    expect(listHandoffs(db)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_events').get()).toMatchObject({
      n: 0,
    });
  });

  it('creates a new handoff when client_request_id is absent', () => {
    const a = post();
    const b = post();
    expect(a.id).not.toBe(b.id);
    expect(listHandoffs(db)).toHaveLength(2);
  });
});

describe('claimHandoff', () => {
  it('lets any agent claim an open-pool handoff and refuses a second claimer', () => {
    const handoff = post();
    const claimed = claimHandoff(db, handoff.id, 'claude', NOW);
    expect(claimed).toMatchObject({
      state: 'CLAIMED',
      claimedBy: 'claude',
    });
    expect(() => claimHandoff(db, handoff.id, 'other', NOW)).toThrow(AgentCoordinationError);
    expect(claimHandoff(db, handoff.id, 'claude', NOW).state).toBe('CLAIMED');
  });

  it('refuses the wrong label on a directed handoff and allows the target', () => {
    const handoff = post({ toAgentLabel: 'claude' });
    expect(() => claimHandoff(db, handoff.id, 'cursor', NOW)).toThrow(/Only claude/);
    expect(claimHandoff(db, handoff.id, 'claude', NOW).claimedBy).toBe('claude');
  });
});

describe('complete, cancel, and notes', () => {
  it('completes only as the claimer and does not write integration events', () => {
    const handoff = post();
    claimHandoff(db, handoff.id, 'claude', NOW);
    expect(() => completeHandoff(db, handoff.id, 'cursor', NOW)).toThrow(AgentCoordinationError);
    const done = completeHandoff(db, handoff.id, 'claude', NOW);
    expect(done.state).toBe('COMPLETED');
    expect(done.completedAt).toBe(NOW.toISOString());
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_events').get()).toMatchObject({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM signal_posts').get()).toMatchObject({ n: 0 });
  });

  it('cancels as agent from OPEN and refuses notes after cancel', () => {
    const handoff = post();
    const cancelled = cancelHandoffAsAgent(
      db,
      handoff.id,
      'cursor',
      { reason: 'No longer needed.' },
      NOW,
    );
    expect(cancelled.state).toBe('CANCELLED');
    expect(() =>
      addHandoffNote(db, handoff.id, { agentLabel: 'cursor', body: 'Too late.' }, NOW),
    ).toThrow(/cancelled/i);
  });

  it('appends notes on OPEN and COMPLETED without changing state', () => {
    const handoff = post();
    const note = addHandoffNote(
      db,
      handoff.id,
      { agentLabel: 'cursor', body: 'Draft is in the composer.' },
      NOW,
    );
    expect(note.body).toBe('Draft is in the composer.');
    expect(getHandoff(db, handoff.id).state).toBe('OPEN');
    claimHandoff(db, handoff.id, 'claude', NOW);
    completeHandoff(db, handoff.id, 'claude', NOW);
    addHandoffNote(db, handoff.id, { agentLabel: 'claude', body: 'Done.' }, NOW);
    expect(getHandoff(db, handoff.id).notes).toHaveLength(2);
  });
});

describe('operator HTTP cancel', () => {
  it('cancels OPEN and CLAIMED, refuses COMPLETED, and lists handoffs', async () => {
    const app = createApp(db);
    const open = post();
    const claimed = post({ message: 'Second handoff.' });
    claimHandoff(db, claimed.id, 'claude', NOW);
    const completed = post({ message: 'Third handoff.' });
    claimHandoff(db, completed.id, 'claude', NOW);
    completeHandoff(db, completed.id, 'claude', NOW);

    const listed = await request(app).get('/api/agent-handoffs');
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(3);

    const cancelOpen = await request(app)
      .post(`/api/agent-handoffs/${open.id}/cancel`)
      .send({ reason: 'Operator closed the pool item.' });
    expect(cancelOpen.status).toBe(200);
    expect(cancelOpen.body.state).toBe('CANCELLED');

    const cancelClaimed = await request(app)
      .post(`/api/agent-handoffs/${claimed.id}/cancel`)
      .send({ reason: 'Stuck claim.' });
    expect(cancelClaimed.status).toBe(200);
    expect(cancelClaimed.body.state).toBe('CANCELLED');

    const cancelDone = await request(app)
      .post(`/api/agent-handoffs/${completed.id}/cancel`)
      .send({ reason: 'Too late.' });
    expect(cancelDone.status).toBe(409);

    const detail = await request(app).get(`/api/agent-handoffs/${open.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.cancelReason).toBe('Operator closed the pool item.');

    expect(cancelHandoffAsOperator(db, open.id, { reason: 'Again.' }, NOW).state).toBe('CANCELLED');
  });

  it('refuses an overlong cancel reason at the Zod boundary', async () => {
    const app = createApp(db);
    const handoff = post();
    const response = await request(app)
      .post(`/api/agent-handoffs/${handoff.id}/cancel`)
      .send({ reason: 'x'.repeat(501) });
    expect(response.status).toBe(400);
  });
});

import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import {
  createConversation,
  listMessages,
  postMessage,
} from './agent-conversations.ts';
import { claimHandoff, completeHandoff, getHandoff } from './agent-coordination/service.ts';

const registerAgent = (db: ReturnType<typeof createDb>, label: string) => {
  db.prepare(
    `INSERT INTO agent_registrations(id,display_label,created_at,last_used_at,last_origin)
     VALUES(?,?,?,?,?)`,
  ).run(`${label}-id`, label, '2026-01-01T00:00:00.000Z', null, null);
};

describe('conversation mention handoffs', () => {
  it('creates confirmed handoffs atomically and links them back to the thread', () => {
    const db = createDb(':memory:');
    registerAgent(db, 'cursor');
    registerAgent(db, 'reviewer');
    const conversation = createConversation(
      db,
      { title: 'Scope', scope: { type: 'project', id: 'p1' }, participantLabels: [] },
      'operator',
    );
    const message = postMessage(db, conversation.id, 'operator', {
      body: '@cursor and @reviewer please review.',
      confirmHandoffs: ['cursor', 'reviewer'],
      clientRequestId: 'post-1',
    });
    expect(message.linkedHandoffs).toHaveLength(2);
    expect(message.linkedHandoffs.map((handoff) => handoff.state)).toEqual(['OPEN', 'OPEN']);

    const page = listMessages(db, conversation.id, 'operator');
    expect(page.items[0]?.linkedHandoffs).toHaveLength(2);

    const detail = getHandoff(db, message.linkedHandoffs[0]!.id);
    expect(detail).toMatchObject({
      toAgentLabel: 'cursor',
      subjectType: 'project',
      subjectId: 'p1',
      sourceConversationId: conversation.id,
      sourceMessageId: message.id,
    });
    expect(
      (
        db
          .prepare(
            'SELECT agent_label FROM agent_conversation_participants WHERE conversation_id=? ORDER BY agent_label',
          )
          .all(conversation.id) as { agent_label: string }[]
      ).map((row) => row.agent_label),
    ).toEqual(['cursor', 'operator', 'reviewer']);
  });

  it('posts without handoffs when mentions are declined or unknown', () => {
    const db = createDb(':memory:');
    registerAgent(db, 'cursor');
    const conversation = createConversation(
      db,
      { title: 'Decline', scope: { type: 'project', id: 'p2' }, participantLabels: [] },
      'operator',
    );
    const declined = postMessage(db, conversation.id, 'operator', {
      body: '@cursor please help',
      confirmHandoffs: [],
    });
    expect(declined.linkedHandoffs).toEqual([]);

    const unknown = postMessage(db, conversation.id, 'operator', {
      body: '@unknown-label please help',
      confirmHandoffs: [],
    });
    expect(unknown.linkedHandoffs).toEqual([]);
    expect(
      db.prepare('SELECT COUNT(*) count FROM agent_handoffs').get() as { count: number },
    ).toMatchObject({ count: 0 });
  });

  it('replays a confirmed post without duplicating rows', () => {
    const db = createDb(':memory:');
    registerAgent(db, 'cursor');
    const conversation = createConversation(
      db,
      { title: 'Replay', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
    );
    const first = postMessage(db, conversation.id, 'operator', {
      body: '@cursor freeform request',
      confirmHandoffs: ['cursor'],
      clientRequestId: 'replay-1',
    });
    const second = postMessage(db, conversation.id, 'operator', {
      body: '@cursor freeform request',
      confirmHandoffs: ['cursor'],
      clientRequestId: 'replay-1',
    });
    expect(second.id).toBe(first.id);
    expect(db.prepare('SELECT COUNT(*) count FROM agent_handoffs').get()).toMatchObject({
      count: 1,
    });
    expect(getHandoff(db, first.linkedHandoffs[0]!.id).subjectId).toBeNull();
  });

  it('lets a confirmed recipient read the originating message after claim and completion', () => {
    const db = createDb(':memory:');
    registerAgent(db, 'worker');
    const conversation = createConversation(
      db,
      { title: 'Access', scope: { type: 'task', id: 't1' }, participantLabels: [] },
      'operator',
    );
    const message = postMessage(db, conversation.id, 'operator', {
      body: '@worker take this',
      confirmHandoffs: ['worker'],
    });
    const handoffId = message.linkedHandoffs[0]!.id;
    claimHandoff(db, handoffId, 'worker');
    completeHandoff(db, handoffId, 'worker', {
      outcome: 'SUCCEEDED',
      resultSummary: 'Done.',
    });
    const workerView = listMessages(db, conversation.id, 'worker');
    expect(workerView.items[0]?.body).toBe('@worker take this');
    expect(workerView.items[0]?.linkedHandoffs[0]?.state).toBe('COMPLETED');
  });
});

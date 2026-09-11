import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import { createConversation, listMessages, postMessage } from './agent-conversations.ts';
import { claimHandoff, completeHandoff, getHandoff } from './agent-coordination/service.ts';
import { listNotifications } from './agent-summaries.ts';

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

  it('notifies each confirmed recipient once with a handoff deep link', () => {
    const db = createDb(':memory:');
    registerAgent(db, 'cursor');
    registerAgent(db, 'reviewer');
    const conversation = createConversation(
      db,
      { title: 'Notify', scope: { type: 'project', id: 'p3' }, participantLabels: [] },
      'operator',
    );
    const message = postMessage(db, conversation.id, 'operator', {
      body: '@cursor and @reviewer please review.',
      confirmHandoffs: ['cursor', 'reviewer'],
    });
    const notifications = listNotifications(db).notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications.map((row) => row.agentLabel).sort()).toEqual(['cursor', 'reviewer']);
    for (const handoff of message.linkedHandoffs) {
      expect(notifications).toContainEqual(
        expect.objectContaining({
          incidentKey: `mention-handoff:${handoff.id}`,
          kind: 'mention_handoff',
          agentLabel: handoff.toAgentLabel,
          title: 'New handoff for you',
          destination: { type: 'handoff', id: handoff.id },
          readAt: null,
        }),
      );
    }
  });

  it('creates no notification when handoffs are declined or labels are unknown', () => {
    const db = createDb(':memory:');
    registerAgent(db, 'cursor');
    const conversation = createConversation(
      db,
      { title: 'No notify', scope: { type: 'project', id: 'p4' }, participantLabels: [] },
      'operator',
    );
    postMessage(db, conversation.id, 'operator', {
      body: '@cursor please help',
      confirmHandoffs: [],
    });
    postMessage(db, conversation.id, 'operator', {
      body: '@unknown-label please help',
      confirmHandoffs: [],
    });
    expect(listNotifications(db).notifications).toEqual([]);
  });

  it('does not duplicate mention notifications on client request replay', () => {
    const db = createDb(':memory:');
    registerAgent(db, 'cursor');
    const conversation = createConversation(
      db,
      { title: 'Notify replay', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
    );
    const first = postMessage(db, conversation.id, 'operator', {
      body: '@cursor freeform request',
      confirmHandoffs: ['cursor'],
      clientRequestId: 'notify-replay-1',
    });
    postMessage(db, conversation.id, 'operator', {
      body: '@cursor freeform request',
      confirmHandoffs: ['cursor'],
      clientRequestId: 'notify-replay-1',
    });
    expect(listNotifications(db).notifications).toHaveLength(1);
    expect(listNotifications(db).notifications[0]).toMatchObject({
      incidentKey: `mention-handoff:${first.linkedHandoffs[0]!.id}`,
      kind: 'mention_handoff',
      agentLabel: 'cursor',
    });
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

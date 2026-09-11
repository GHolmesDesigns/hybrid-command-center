import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import {
  clearConversationDecision,
  createConversation,
  listConversations,
  listMessages,
  markConversationDecision,
  postMessage,
  setConversationState,
} from './agent-conversations.ts';

describe('agent conversations', () => {
  it('keeps sender identity server-owned, enforces participants, and resumes messages by cursor', () => {
    const db = createDb(':memory:');
    const conversation = createConversation(
      db,
      { title: 'Review', scope: { type: 'task', id: 'task-1' }, participantLabels: ['claude'] },
      'cursor',
      new Date('2026-09-08T12:00:00.000Z'),
    );
    const first = postMessage(
      db,
      conversation.id,
      'cursor',
      'First message',
      new Date('2026-09-08T12:01:00.000Z'),
    );
    postMessage(
      db,
      conversation.id,
      'claude',
      'Second message',
      new Date('2026-09-08T12:02:00.000Z'),
    );
    expect(first.senderLabel).toBe('cursor');
    expect(first.provenance).toBe('ASSERTED');
    expect(listMessages(db, conversation.id, 'claude', { limit: 1 }).items).toHaveLength(1);
    const page = listMessages(db, conversation.id, 'claude', { limit: 1 });
    expect(page.nextCursor).toBeTruthy();
    expect(
      listMessages(db, conversation.id, 'claude', { cursor: page.nextCursor! }).items[0]
        .senderLabel,
    ).toBe('claude');
    expect(() => listMessages(db, conversation.id, 'other')).toThrow(/not found/i);
  });

  it('keeps frozen provenance and pages older messages without duplicates', () => {
    const db = createDb(':memory:');
    const conversation = createConversation(
      db,
      { title: 'Reverse', scope: { type: 'freeform' }, participantLabels: [] },
      'cursor',
    );
    postMessage(db, conversation.id, 'cursor', 'One', new Date('2026-09-08T12:01:00.000Z'));
    postMessage(db, conversation.id, 'cursor', 'Two', new Date('2026-09-08T12:02:00.000Z'));
    postMessage(db, conversation.id, 'cursor', 'Three', new Date('2026-09-08T12:03:00.000Z'));
    const newest = listMessages(db, conversation.id, 'cursor', { direction: 'before', limit: 2 });
    expect(newest.items.map((message) => message.body)).toEqual(['Two', 'Three']);
    expect(newest.nextCursor).toBeTruthy();
    const older = listMessages(db, conversation.id, 'cursor', {
      direction: 'before',
      limit: 2,
      cursor: newest.nextCursor!,
    });
    expect(older.items.map((message) => message.body)).toEqual(['One']);
    expect(new Set([...newest.items, ...older.items].map((message) => message.id)).size).toBe(3);
  });

  it('stores agent thought summaries and refuses them on operator posts', () => {
    const db = createDb(':memory:');
    const conversation = createConversation(
      db,
      { title: 'Thoughts', scope: { type: 'freeform' }, participantLabels: ['reviewer'] },
      'operator',
    );
    const agent = postMessage(
      db,
      conversation.id,
      'reviewer',
      {
        body: 'Here is the answer.',
        thoughtSummary: 'I checked the queue health rules first.',
      },
      new Date('2026-09-08T12:01:00.000Z'),
    );
    const operator = postMessage(
      db,
      conversation.id,
      'operator',
      {
        body: 'Thanks.',
        thoughtSummary: 'Should be ignored.',
      },
      new Date('2026-09-08T12:02:00.000Z'),
    );
    expect(agent.thoughtSummary).toBe('I checked the queue health rules first.');
    expect(operator.thoughtSummary).toBeNull();
    expect(
      listMessages(db, conversation.id, 'reviewer').items.map((m) => m.thoughtSummary),
    ).toEqual(['I checked the queue health rules first.', null]);
  });

  it('archives without deleting messages and excludes archived rows when filtered', () => {
    const db = createDb(':memory:');
    const conversation = createConversation(
      db,
      { title: 'Archive me', scope: { type: 'freeform' }, participantLabels: [] },
      'cursor',
    );
    postMessage(db, conversation.id, 'cursor', 'Retained');
    setConversationState(db, conversation.id, 'cursor', 'ARCHIVED');
    expect(listConversations(db, 'cursor', { state: 'ACTIVE' }).items).toHaveLength(0);
    expect(listMessages(db, conversation.id, 'cursor').items[0].body).toBe('Retained');
  });

  it('filters detail discussions in SQL scope before cursor pagination', () => {
    const db = createDb(':memory:');
    createConversation(
      db,
      { title: 'Project one', scope: { type: 'project', id: 'p1' }, participantLabels: [] },
      'cursor',
    );
    createConversation(
      db,
      { title: 'Project two', scope: { type: 'project', id: 'p2' }, participantLabels: [] },
      'cursor',
    );
    const page = listConversations(db, 'cursor', { scopeType: 'project', scopeId: 'p1', limit: 1 });
    expect(page.items.map((item) => item.title)).toEqual(['Project one']);
    expect(page.hasMore).toBe(false);
  });

  it('persists decision metadata, filters decided threads, and clears the complete mark', () => {
    const db = createDb(':memory:');
    const decided = createConversation(
      db,
      { title: 'Decision thread', scope: { type: 'project', id: 'p1' }, participantLabels: [] },
      'operator',
      new Date('2026-09-10T12:00:00.000Z'),
    );
    const ordinary = createConversation(
      db,
      { title: 'Ordinary thread', scope: { type: 'project', id: 'p1' }, participantLabels: [] },
      'operator',
      new Date('2026-09-10T12:01:00.000Z'),
    );

    const marked = markConversationDecision(
      db,
      decided.id,
      'operator',
      { outcome: 'Use the approved brief.' },
      new Date('2026-09-10T12:02:00.000Z'),
    );
    expect(marked).toMatchObject({
      id: decided.id,
      isDecision: true,
      decisionOutcome: 'Use the approved brief.',
      decidedAt: '2026-09-10T12:02:00.000Z',
    });
    expect(
      listConversations(db, 'operator', { isDecision: true }).items.map((item) => item.id),
    ).toEqual([decided.id]);
    expect(
      listConversations(db, 'operator', { isDecision: false }).items.map((item) => item.id),
    ).toContain(ordinary.id);

    const updated = markConversationDecision(
      db,
      decided.id,
      'operator',
      { outcome: 'Ship the approved brief.' },
      new Date('2026-09-10T12:03:00.000Z'),
    );
    expect(updated.decisionOutcome).toBe('Ship the approved brief.');
    expect(updated.decidedAt).toBe('2026-09-10T12:02:00.000Z');

    const cleared = clearConversationDecision(
      db,
      decided.id,
      'operator',
      new Date('2026-09-10T12:04:00.000Z'),
    );
    expect(cleared).toMatchObject({
      isDecision: false,
      decisionOutcome: null,
      decidedAt: null,
    });
    expect(listConversations(db, 'operator', { isDecision: true }).items).toHaveLength(0);
  });
});

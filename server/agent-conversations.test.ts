import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import {
  createConversation,
  listConversations,
  listMessages,
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
    expect(listMessages(db, conversation.id, 'claude', { limit: 1 }).items).toHaveLength(1);
    const page = listMessages(db, conversation.id, 'claude', { limit: 1 });
    expect(page.nextCursor).toBeTruthy();
    expect(
      listMessages(db, conversation.id, 'claude', { cursor: page.nextCursor! }).items[0]
        .senderLabel,
    ).toBe('claude');
    expect(() => listMessages(db, conversation.id, 'other')).toThrow(/not found/i);
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
});

import { describe, expect, it } from 'vitest';
import { createConversation, listMessages } from '../agent-conversations.ts';
import { createDb } from '../db.ts';
import { insertAssistantMessage } from './messages.ts';

describe('insertAssistantMessage', () => {
  it('persists a verified assistant reply and bumps the conversation timestamp', () => {
    const db = createDb(':memory:');
    const conversation = createConversation(
      db,
      { title: 'Assistant message', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
      new Date('2026-09-11T12:00:00.000Z'),
    );
    const messageId = insertAssistantMessage(
      db,
      conversation.id,
      'Pipeline reply',
      new Date('2026-09-11T12:01:00.000Z'),
    );
    const messages = listMessages(db, conversation.id, 'operator').items;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: messageId,
      senderKind: 'assistant',
      body: 'Pipeline reply',
      provenance: 'VERIFIED',
    });
  });
});

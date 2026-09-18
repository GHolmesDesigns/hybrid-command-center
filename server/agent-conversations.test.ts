import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import {
  clearConversationDecision,
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  markConversationDecision,
  postMessage,
  promoteConversationToCanonical,
  resolveCanonicalConversationId,
  resolveScopedConversation,
  setConversationState,
  setConversationTyping,
} from './agent-conversations.ts';
import {
  AgentHubTypingRegistry,
  registerAgentHubTypingRegistry,
} from './agent-hub/typing.ts';

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

  it('promotes a registered agent to participant on first in-thread post', () => {
    const db = createDb(':memory:');
    const conversation = createConversation(
      db,
      { title: 'Operator thread', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
    );
    expect(() => listMessages(db, conversation.id, 'cursor')).toThrow(/not found/i);
    const message = postMessage(db, conversation.id, 'cursor', 'Joining the thread.');
    expect(message.senderLabel).toBe('cursor');
    expect(
      (
        db
          .prepare(
            'SELECT agent_label FROM agent_conversation_participants WHERE conversation_id=? ORDER BY agent_label',
          )
          .all(conversation.id) as { agent_label: string }[]
      ).map((row) => row.agent_label),
    ).toEqual(['cursor', 'operator']);
    expect(listMessages(db, conversation.id, 'cursor').items[0]?.body).toBe('Joining the thread.');
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

  it('marks the first scoped thread canonical, treats later ones as secondary, and clears canonical on archive', () => {
    const db = createDb(':memory:');
    const first = createConversation(
      db,
      { title: 'Primary', scope: { type: 'project', id: 'p1' }, participantLabels: [] },
      'operator',
    );
    const second = createConversation(
      db,
      { title: 'Secondary', scope: { type: 'project', id: 'p1' }, participantLabels: [] },
      'operator',
    );
    expect(first.isCanonical).toBe(true);
    expect(second.isCanonical).toBe(false);
    expect(resolveCanonicalConversationId(db, 'project', 'p1')).toBe(first.id);
    setConversationState(db, first.id, 'operator', 'ARCHIVED');
    expect(resolveCanonicalConversationId(db, 'project', 'p1')).toBeNull();
    const resolution = resolveScopedConversation(db, 'project', 'p1', 'operator');
    expect(resolution.canonicalId).toBeNull();
    expect(resolution.secondaryThreads.map((thread) => thread.id)).toEqual([second.id]);
  });

  it('refuses to promote freeform or archived conversations to canonical', () => {
    const db = createDb(':memory:');
    const freeform = createConversation(
      db,
      { title: 'Freeform', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
    );
    expect(() => promoteConversationToCanonical(db, freeform.id, 'operator')).toThrow(
      /scoped conversations/i,
    );
    const archived = createConversation(
      db,
      { title: 'Archived scoped', scope: { type: 'task', id: 't1' }, participantLabels: [] },
      'operator',
    );
    setConversationState(db, archived.id, 'operator', 'ARCHIVED');
    expect(() => promoteConversationToCanonical(db, archived.id, 'operator')).toThrow(
      /active conversations/i,
    );
  });

  it('creates explicit secondary scoped threads when requested', () => {
    const db = createDb(':memory:');
    createConversation(
      db,
      { title: 'Primary', scope: { type: 'project', id: 'p1' }, participantLabels: [] },
      'operator',
    );
    const secondary = createConversation(
      db,
      {
        title: 'Side thread',
        scope: { type: 'project', id: 'p1' },
        participantLabels: [],
        secondary: true,
      },
      'operator',
    );
    expect(secondary.isCanonical).toBe(false);
    expect(resolveCanonicalConversationId(db, 'project', 'p1')).not.toBe(secondary.id);
  });

  it('promotes a secondary scoped thread to canonical without archiving siblings', () => {
    const db = createDb(':memory:');
    const canonical = createConversation(
      db,
      { title: 'Primary', scope: { type: 'client', id: 'c1' }, participantLabels: [] },
      'operator',
    );
    const secondary = createConversation(
      db,
      { title: 'Side thread', scope: { type: 'client', id: 'c1' }, participantLabels: [] },
      'operator',
    );
    const promoted = promoteConversationToCanonical(db, secondary.id, 'operator');
    expect(promoted.isCanonical).toBe(true);
    expect(getConversation(db, canonical.id, 'operator').isCanonical).toBe(false);
    expect(resolveCanonicalConversationId(db, 'client', 'c1')).toBe(secondary.id);
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

  it('signals ephemeral typing without writing messages', () => {
    const db = createDb(':memory:');
    const registry = new AgentHubTypingRegistry();
    registerAgentHubTypingRegistry(registry);
    const conversation = createConversation(
      db,
      { title: 'Typing', scope: { type: 'freeform' }, participantLabels: ['reviewer'] },
      'operator',
    );
    const before = listMessages(db, conversation.id, 'operator', { limit: 10 }).items.length;

    const signal = setConversationTyping(db, conversation.id, 'reviewer', true);
    expect(signal).toMatchObject({
      conversationId: conversation.id,
      agentLabel: 'reviewer',
      active: true,
    });
    expect(listMessages(db, conversation.id, 'operator', { limit: 10 }).items).toHaveLength(before);

    registerAgentHubTypingRegistry(null);
  });
});

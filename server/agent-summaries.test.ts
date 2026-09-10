import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import { createConversation, postMessage } from './agent-conversations.ts';
import { postHandoff } from './agent-coordination/service.ts';
import {
  buildSummary,
  getPresence,
  listNotifications,
  listPresence,
  listSummaries,
  markNotificationRead,
  markAllNotificationsRead,
  notify,
  setPresence,
} from './agent-summaries.ts';

describe('agent presence', () => {
  it('sets and reads presence, keyed by agent label', () => {
    const db = createDb(':memory:');
    const saved = setPresence(
      db,
      'reviewer',
      { state: 'AVAILABLE', availability: 'Free until 3pm' },
      new Date('2026-09-08T12:00:00.000Z'),
    );
    expect(saved).toEqual({
      agentLabel: 'reviewer',
      state: 'AVAILABLE',
      availability: 'Free until 3pm',
      verifiedAt: '2026-09-08T12:00:00.000Z',
      lastActivityAt: '2026-09-08T12:00:00.000Z',
    });
    expect(getPresence(db, 'reviewer')).toEqual(saved);
    db.close();
  });

  it('upserts on a repeat call for the same agent', () => {
    const db = createDb(':memory:');
    setPresence(db, 'reviewer', { state: 'AVAILABLE' }, new Date('2026-09-08T12:00:00.000Z'));
    const updated = setPresence(
      db,
      'reviewer',
      { state: 'BUSY' },
      new Date('2026-09-08T12:30:00.000Z'),
    );
    expect(updated.state).toBe('BUSY');
    expect(listPresence(db).presence).toHaveLength(1);
    db.close();
  });

  it('throws 404 for presence that was never set', () => {
    const db = createDb(':memory:');
    expect(() => getPresence(db, 'nobody')).toThrow('Presence not found.');
    try {
      getPresence(db, 'nobody');
      expect.unreachable();
    } catch (error) {
      expect((error as { status?: number }).status).toBe(404);
    }
    db.close();
  });

  it('lists presence filtered by agent label', () => {
    const db = createDb(':memory:');
    setPresence(db, 'reviewer', { state: 'AVAILABLE' });
    setPresence(db, 'planner', { state: 'AWAY' });
    expect(listPresence(db).presence.map((p) => p.agentLabel)).toEqual(['planner', 'reviewer']);
    expect(listPresence(db, { agentLabel: 'planner' }).presence).toHaveLength(1);
    db.close();
  });
});

describe('agent summaries', () => {
  it('summarizes an agent with no recent activity', () => {
    const db = createDb(':memory:');
    const summary = buildSummary(db, 'reviewer', new Date('2026-09-08T12:00:00.000Z'));
    expect(summary.agentLabel).toBe('reviewer');
    expect(summary.text).toBe('reviewer: 0 recent messages; 0 recent handoffs.');
    expect(summary.evidence).toEqual([]);
    expect(summary.generatedAt).toBe('2026-09-08T12:00:00.000Z');
    db.close();
  });

  it('summarizes recent messages and handoffs with correct grammar and evidence', () => {
    const db = createDb(':memory:');
    const conversation = createConversation(
      db,
      { title: 'Ship review', scope: { type: 'freeform' }, participantLabels: ['planner'] },
      'reviewer',
    );
    postMessage(db, conversation.id, 'reviewer', 'Looks good to me.');
    postHandoff(db, {
      fromAgentLabel: 'reviewer',
      subjectType: 'freeform',
      message: 'Handing this off.',
    });

    const summary = buildSummary(db, 'reviewer');
    expect(summary.text).toBe('reviewer: 1 recent message; 1 recent handoff.');
    expect(summary.evidence).toHaveLength(2);
    expect(summary.evidence.some((e) => e.startsWith('conversation-message:'))).toBe(true);
    expect(summary.evidence.some((e) => e.startsWith('handoff:'))).toBe(true);
    db.close();
  });

  it('includes a handoff addressed to the agent as well as one sent from it', () => {
    const db = createDb(':memory:');
    postHandoff(db, {
      fromAgentLabel: 'planner',
      toAgentLabel: 'reviewer',
      subjectType: 'freeform',
      message: 'Please review this.',
    });
    const summary = buildSummary(db, 'reviewer');
    expect(summary.text).toContain('1 recent handoff');
    db.close();
  });

  it('lists summaries for an explicit agent label without touching the registry', () => {
    const db = createDb(':memory:');
    const { summaries } = listSummaries(db, { agentLabel: 'reviewer' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].agentLabel).toBe('reviewer');
    db.close();
  });

  it('lists summaries for every registered agent when no label is given', () => {
    const db = createDb(':memory:');
    db.prepare(
      'INSERT INTO agent_registrations(id,display_label,created_at,last_used_at,last_origin) VALUES(?,?,?,?,?)',
    ).run('a1', 'planner', '2026-01-01T00:00:00.000Z', null, 'test');
    db.prepare(
      'INSERT INTO agent_registrations(id,display_label,created_at,last_used_at,last_origin) VALUES(?,?,?,?,?)',
    ).run('a2', 'reviewer', '2026-01-01T00:00:00.000Z', null, 'test');
    const { summaries } = listSummaries(db);
    expect(summaries.map((s) => s.agentLabel)).toEqual(
      expect.arrayContaining(['planner', 'reviewer']),
    );
    expect(summaries).toHaveLength(3);
    db.close();
  });
});

describe('agent notifications', () => {
  it('creates, lists, and marks a notification read', () => {
    const db = createDb(':memory:');
    const created = notify(
      db,
      {
        incidentKey: 'agent-offline:reviewer',
        kind: 'presence',
        agentLabel: 'reviewer',
        title: 'Agent went offline',
        body: 'reviewer has not checked in.',
      },
      new Date('2026-09-08T12:00:00.000Z'),
    );
    expect(created.readAt).toBeNull();
    expect(listNotifications(db).unreadCount).toBe(1);
    expect(listNotifications(db).notifications).toEqual([created]);
    expect(listNotifications(db, { unreadOnly: true }).notifications).toEqual([created]);

    const read = markNotificationRead(db, created.id, new Date('2026-09-08T12:05:00.000Z'));
    expect(read.readAt).toBe('2026-09-08T12:05:00.000Z');
    expect(listNotifications(db, { unreadOnly: true }).notifications).toEqual([]);
    expect(listNotifications(db).notifications).toEqual([read]);
    expect(markAllNotificationsRead(db).marked).toBe(0);
    db.close();
  });

  it('is idempotent for a repeated incident key', () => {
    const db = createDb(':memory:');
    const input = {
      incidentKey: 'agent-offline:reviewer',
      kind: 'presence',
      agentLabel: 'reviewer',
      title: 'Agent went offline',
      body: 'reviewer has not checked in.',
    };
    const first = notify(db, input);
    const second = notify(db, { ...input, body: 'a different body' });
    expect(second).toEqual(first);
    expect(listNotifications(db).notifications).toHaveLength(1);
    db.close();
  });

  it('throws 404 marking a notification that does not exist or is already read', () => {
    const db = createDb(':memory:');
    expect(() => markNotificationRead(db, 'missing')).toThrow('Notification not found.');
    const created = notify(db, {
      incidentKey: 'agent-offline:reviewer',
      kind: 'presence',
      agentLabel: 'reviewer',
      title: 'Agent went offline',
      body: 'reviewer has not checked in.',
    });
    markNotificationRead(db, created.id);
    expect(() => markNotificationRead(db, created.id)).toThrow('Notification not found.');
    db.close();
  });

  it('reports exact unread counts, paginates, and validates destinations', () => {
    const db = createDb(':memory:');
    for (let i = 0; i < 3; i++)
      notify(
        db,
        {
          incidentKey: `incident-${i}`,
          kind: 'test',
          agentLabel: 'reviewer',
          title: `Title ${i}`,
          body: 'Body',
        },
        new Date(2026, 0, 1, 0, i),
      );
    const first = listNotifications(db, { limit: 2 });
    expect(first.notifications).toHaveLength(2);
    expect(first.unreadCount).toBe(3);
    expect(first.nextCursor).toBeTruthy();
    expect(
      listNotifications(db, { limit: 2, cursor: first.nextCursor! }).notifications,
    ).toHaveLength(1);
    expect(markAllNotificationsRead(db).marked).toBe(3);
    expect(markAllNotificationsRead(db).marked).toBe(0);
    expect(() =>
      notify(db, {
        incidentKey: 'bad-destination',
        kind: 'test',
        agentLabel: 'reviewer',
        title: 'Bad',
        body: 'Bad',
        destination: { type: 'conversation', id: 'missing' },
      }),
    ).toThrow('does not exist');
    db.close();
  });
});

import { describe, expect, it } from 'vitest';
import {
  AGENT_COORDINATION_LIMITS,
  agentHandoffCancelReasonSchema,
  agentHandoffMessageSchema,
  agentHandoffNoteBodySchema,
  agentLabelSchema,
  containsCredentialShape,
  groupHandoffsForInbox,
  handoffInInboxHistory,
  handoffMessageExcerpt,
  handoffSubjectPath,
  isStaleOpenHandoff,
  type AgentHandoff,
} from './agent-coordination.ts';

const handoff = (overrides: Partial<AgentHandoff> = {}): AgentHandoff => ({
  id: 'h1',
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: '2026-08-01T12:00:00.000Z',
  fromAgentLabel: 'cursor',
  fromAgentProvenance: 'UNKNOWN',
  toAgentLabel: null,
  subjectType: 'freeform',
  subjectId: null,
  message: 'Please review this caption.',
  state: 'OPEN',
  claimedBy: null,
  claimedByProvenance: null,
  claimedAt: null,
  completedAt: null,
  completedByProvenance: null,
  cancelledAt: null,
  cancelReason: null,
  clientRequestId: null,
  ...overrides,
});

describe('agent label schema', () => {
  it('accepts portable labels and refuses empty or illegal charset', () => {
    expect(agentLabelSchema.parse('cursor')).toBe('cursor');
    expect(agentLabelSchema.parse(' Claude-Code ')).toBe('Claude-Code');
    expect(agentLabelSchema.parse('a')).toBe('a');
    expect(() => agentLabelSchema.parse('')).toThrow();
    expect(() => agentLabelSchema.parse('-leading')).toThrow();
    expect(() => agentLabelSchema.parse('trailing-')).toThrow();
    expect(() => agentLabelSchema.parse('has space')).toThrow();
    expect(() =>
      agentLabelSchema.parse('a'.repeat(AGENT_COORDINATION_LIMITS.agentLabel + 1)),
    ).toThrow();
  });
});

describe('handoff free-text bounds', () => {
  it('enforces length and refuses credential-shaped bodies', () => {
    expect(agentHandoffMessageSchema.parse(' Please review this caption. ')).toBe(
      'Please review this caption.',
    );
    expect(() => agentHandoffMessageSchema.parse('')).toThrow();
    expect(() =>
      agentHandoffMessageSchema.parse('x'.repeat(AGENT_COORDINATION_LIMITS.message + 1)),
    ).toThrow();
    expect(() => agentHandoffMessageSchema.parse('api_key=sk-live-secret')).toThrow(/credentials/i);
    expect(() => agentHandoffNoteBodySchema.parse('Bearer ya29.a0AfH6')).toThrow(/credentials/i);
    expect(() => agentHandoffCancelReasonSchema.parse('password: hunter2')).toThrow(/credentials/i);
    expect(containsCredentialShape('https://example.com/path?ref=abc')).toBe(false);
  });
});

describe('operator inbox helpers', () => {
  const now = new Date('2026-08-26T15:00:00.000Z');

  it('flags OPEN handoffs older than the TTL and groups live vs 7-day history', () => {
    expect(isStaleOpenHandoff(handoff({ createdAt: '2026-07-20T12:00:00.000Z' }), now)).toBe(true);
    expect(isStaleOpenHandoff(handoff({ createdAt: '2026-08-20T12:00:00.000Z' }), now)).toBe(false);
    expect(isStaleOpenHandoff(handoff({ state: 'CLAIMED' }), now)).toBe(false);

    const groups = groupHandoffsForInbox(
      [
        handoff({ id: 'open' }),
        handoff({ id: 'claimed', state: 'CLAIMED', claimedBy: 'claude' }),
        handoff({
          id: 'done-recent',
          state: 'COMPLETED',
          completedAt: '2026-08-25T12:00:00.000Z',
        }),
        handoff({
          id: 'done-old',
          state: 'COMPLETED',
          completedAt: '2026-08-01T12:00:00.000Z',
        }),
        handoff({
          id: 'cancelled-recent',
          state: 'CANCELLED',
          cancelledAt: '2026-08-24T12:00:00.000Z',
          cancelReason: 'Stopped.',
        }),
        handoff({
          id: 'cancelled-old',
          state: 'CANCELLED',
          cancelledAt: '2026-07-01T12:00:00.000Z',
          cancelReason: 'Ancient.',
        }),
      ],
      now,
    );
    expect(groups.open.map((row) => row.id)).toEqual(['open']);
    expect(groups.claimed.map((row) => row.id)).toEqual(['claimed']);
    expect(groups.completed.map((row) => row.id)).toEqual(['done-recent']);
    expect(groups.cancelled.map((row) => row.id)).toEqual(['cancelled-recent']);
  });

  it('treats live states as in-history and drops terminal rows missing a stamp', () => {
    expect(handoffInInboxHistory(handoff({ state: 'OPEN' }), now)).toBe(true);
    expect(handoffInInboxHistory(handoff({ state: 'CLAIMED' }), now)).toBe(true);
    expect(handoffInInboxHistory(handoff({ state: 'COMPLETED', completedAt: null }), now)).toBe(
      false,
    );
    expect(handoffInInboxHistory(handoff({ state: 'CANCELLED', cancelledAt: null }), now)).toBe(
      false,
    );
  });

  it('builds subject paths and truncates message excerpts', () => {
    expect(handoffSubjectPath({ subjectType: 'client', subjectId: 'c1' })).toBe('/clients/c1');
    expect(handoffSubjectPath({ subjectType: 'project', subjectId: 'p1' })).toBe('/projects/p1');
    expect(handoffSubjectPath({ subjectType: 'signal_post', subjectId: 'post-1' })).toBe(
      '/signal?post=post-1',
    );
    expect(
      handoffSubjectPath({ subjectType: 'task', subjectId: 't1' }, [{ id: 't1', projectId: 'p9' }]),
    ).toBe('/status?project=p9');
    expect(handoffSubjectPath({ subjectType: 'task', subjectId: 'missing' }, [])).toBeNull();
    expect(handoffSubjectPath({ subjectType: 'freeform', subjectId: 'x' })).toBeNull();
    expect(handoffMessageExcerpt('short')).toBe('short');
    expect(handoffMessageExcerpt('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(handoffMessageExcerpt('x'.repeat(200)).length).toBe(140);
  });
});

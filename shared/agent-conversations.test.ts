import { describe, expect, it } from 'vitest';
import {
  conversationDecisionSchema,
  conversationListSchema,
  conversationScopeSchema,
  createConversationSchema,
} from './agent-conversations.ts';

describe('agent conversation schemas', () => {
  it('requires identifiers for client, project, and task scopes', () => {
    for (const type of ['client', 'project', 'task'] as const) {
      expect(() => conversationScopeSchema.parse({ type })).toThrow(
        'A scoped conversation requires an id.',
      );
    }
    expect(conversationScopeSchema.parse({ type: 'freeform' })).toEqual({ type: 'freeform' });
  });

  it('defaults participants while preserving normalized input', () => {
    expect(
      createConversationSchema.parse({
        title: '  Planning  ',
        scope: { type: 'project', id: 'p1' },
      }),
    ).toEqual({ title: 'Planning', scope: { type: 'project', id: 'p1' }, participantLabels: [] });
  });

  it('requires paired workspace scope filters and rejects freeform detail filters', () => {
    expect(() =>
      createConversationSchema.parse({
        title: 'x',
        scope: { type: 'project', id: 'p1' },
        participantLabels: [],
      }),
    ).not.toThrow();
    expect(() => conversationListSchema.parse({ scopeType: 'project' })).toThrow();
    expect(() => conversationListSchema.parse({ scopeType: 'freeform', scopeId: 'x' })).toThrow();
  });

  it('normalizes the decision list query and bounds optional outcomes', () => {
    expect(conversationListSchema.parse({ isDecision: 'true' }).isDecision).toBe(true);
    expect(conversationListSchema.parse({ isDecision: false }).isDecision).toBe(false);
    expect(conversationDecisionSchema.parse({ outcome: '  Approved  ' })).toEqual({
      outcome: 'Approved',
    });
    expect(conversationDecisionSchema.parse({ outcome: '' })).toEqual({ outcome: '' });
    expect(() => conversationDecisionSchema.parse({ outcome: 'x'.repeat(501) })).toThrow();
  });
});

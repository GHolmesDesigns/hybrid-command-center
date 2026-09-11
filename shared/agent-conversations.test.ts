import { describe, expect, it } from 'vitest';
import {
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
});

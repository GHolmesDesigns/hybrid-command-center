import { describe, expect, it } from 'vitest';
import {
  pageScopeFromSubject,
  scopeChangeDismissKey,
  shouldOfferScopeChangePrompt,
} from './conversation-scope-prompt.ts';

describe('conversation scope-change prompt', () => {
  it('builds stable dismiss keys', () => {
    expect(
      scopeChangeDismissKey({ type: 'project', id: 'p1' }, { type: 'freeform', id: null }),
    ).toBe('project:p1|freeform:');
  });

  it('offers a prompt only when page and thread scopes differ', () => {
    expect(
      shouldOfferScopeChangePrompt({
        pageScope: { type: 'project', id: 'p1' },
        threadScope: { type: 'freeform', id: null },
        dismissed: false,
      }),
    ).toBe(true);
    expect(
      shouldOfferScopeChangePrompt({
        pageScope: { type: 'project', id: 'p1' },
        threadScope: { type: 'project', id: 'p1' },
        dismissed: false,
      }),
    ).toBe(false);
    expect(
      shouldOfferScopeChangePrompt({
        pageScope: null,
        threadScope: { type: 'freeform', id: null },
        dismissed: false,
      }),
    ).toBe(false);
    expect(
      shouldOfferScopeChangePrompt({
        pageScope: { type: 'client', id: 'c1' },
        threadScope: { type: 'task', id: 't1' },
        dismissed: true,
      }),
    ).toBe(false);
  });

  it('maps workspace page subjects to conversation page scopes', () => {
    expect(pageScopeFromSubject('project', 'p1')).toEqual({ type: 'project', id: 'p1' });
    expect(pageScopeFromSubject('signal_post', 'post-1')).toBeNull();
    expect(pageScopeFromSubject(null, null)).toBeNull();
  });
});

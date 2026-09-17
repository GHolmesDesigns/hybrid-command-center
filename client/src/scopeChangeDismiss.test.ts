import { beforeEach, describe, expect, it } from 'vitest';
import { dismissScopeChangePair, isScopeChangeDismissed } from './scopeChangeDismiss';

describe('scopeChangeDismiss', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('remembers dismissed scope-change pairs for the browser session', () => {
    const key = 'project:p1|freeform:';
    expect(isScopeChangeDismissed(key)).toBe(false);
    dismissScopeChangePair(key);
    expect(isScopeChangeDismissed(key)).toBe(true);
    expect(isScopeChangeDismissed('project:p2|freeform:')).toBe(false);
  });
});

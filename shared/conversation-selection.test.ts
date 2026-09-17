import { describe, expect, it } from 'vitest';
import {
  conversationOpenQuery,
  conversationsPathWithOpen,
  drawerSelectionIssue,
  fullViewSelectionIssue,
  mergeSelectionSnapshot,
  readOpenConversationParam,
  selectionUpdateEcho,
} from './conversation-selection.ts';

describe('conversation selection bridge', () => {
  it('reads and builds the open conversation query parameter', () => {
    expect(readOpenConversationParam('open=abc-123&scopeType=client')).toBe('abc-123');
    expect(readOpenConversationParam('?open=abc-123')).toBe('abc-123');
    expect(readOpenConversationParam('')).toBeNull();
    expect(conversationOpenQuery('abc 123')).toBe('open=abc%20123');
    expect(conversationsPathWithOpen('thread-1')).toBe('/agents/conversations?open=thread-1');
  });

  it('flags drawer issues for missing and archived threads without substituting', () => {
    expect(drawerSelectionIssue(null, null)).toBeNull();
    expect(drawerSelectionIssue('c1', null)).toBe('missing');
    expect(
      drawerSelectionIssue('c1', { scopeType: 'project', scopeId: 'p1', state: 'ACTIVE' }),
    ).toBeNull();
    expect(
      drawerSelectionIssue('c1', { scopeType: 'freeform', scopeId: null, state: 'ARCHIVED' }),
    ).toBe('archived_in_drawer');
    expect(
      drawerSelectionIssue('c1', { scopeType: 'freeform', scopeId: null, state: 'ACTIVE' }),
    ).toBeNull();
  });

  it('flags only missing threads for the full view', () => {
    expect(
      fullViewSelectionIssue('c1', { scopeType: 'task', scopeId: 't1', state: 'ARCHIVED' }),
    ).toBeNull();
    expect(fullViewSelectionIssue('c1', null)).toBe('missing');
  });

  it('detects echo updates from the same source and id', () => {
    expect(selectionUpdateEcho('c1', 'c1', 'drawer', 'drawer')).toBe(true);
    expect(selectionUpdateEcho('c1', 'c2', 'drawer', 'drawer')).toBe(false);
    expect(selectionUpdateEcho('c1', 'c1', 'drawer', 'full-view')).toBe(false);
  });

  it('merges selection snapshots per surface', () => {
    expect(
      mergeSelectionSnapshot(
        'c1',
        'url',
        { scopeType: 'freeform', scopeId: null, state: 'ACTIVE' },
        'drawer',
      ),
    ).toEqual({ conversationId: 'c1', source: 'url', issue: null });
    expect(
      mergeSelectionSnapshot(
        'c1',
        'full-view',
        { scopeType: 'project', scopeId: 'p1', state: 'ACTIVE' },
        'full-view',
      ),
    ).toEqual({ conversationId: 'c1', source: 'full-view', issue: null });
  });
});

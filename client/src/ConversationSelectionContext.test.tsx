import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConversationSelectionProvider } from './components/ConversationSelectionProvider';
import { useConversationSelection } from './useConversationSelection';

function LocationProbe() {
  useLocation();
  return null;
}

function wrapper(initialEntry: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/agents/conversations"
            element={
              <ConversationSelectionProvider>
                <LocationProbe />
                {children}
              </ConversationSelectionProvider>
            }
          />
          <Route
            path="/"
            element={
              <ConversationSelectionProvider>
                <LocationProbe />
                {children}
              </ConversationSelectionProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    );
  };
}

describe('ConversationSelectionProvider', () => {
  it('reads the URL open parameter on the conversations page', async () => {
    const { result } = renderHook(() => useConversationSelection(), {
      wrapper: wrapper('/agents/conversations?open=thread-a'),
    });
    await waitFor(() => expect(result.current.conversationId).toBe('thread-a'));
    expect(result.current.source).toBe('url');
    expect(result.current.onConversationsPage).toBe(true);
  });

  it('updates the URL when the drawer selects a thread on the conversations page', async () => {
    const { result } = renderHook(
      () => ({
        bridge: useConversationSelection(),
        location: useLocation(),
      }),
      { wrapper: wrapper('/agents/conversations') },
    );
    await waitFor(() => expect(result.current.bridge.onConversationsPage).toBe(true));
    act(() => {
      result.current.bridge.applySelection('thread-b', 'drawer', {
        scopeType: 'freeform',
        state: 'ACTIVE',
      });
    });
    await waitFor(() => {
      expect(result.current.bridge.conversationId).toBe('thread-b');
      expect(result.current.location.search).toContain('open=thread-b');
    });
    expect(result.current.bridge.source).toBe('drawer');
    expect(result.current.bridge.drawerIssue).toBeNull();
  });

  it('keeps memory selection off the conversations page without rewriting the URL', async () => {
    const { result } = renderHook(
      () => ({
        bridge: useConversationSelection(),
        location: useLocation(),
      }),
      { wrapper: wrapper('/') },
    );
    await waitFor(() => expect(result.current.bridge.onConversationsPage).toBe(false));
    act(() => {
      result.current.bridge.applySelection('thread-c', 'drawer', {
        scopeType: 'freeform',
        state: 'ACTIVE',
      });
    });
    await waitFor(() => expect(result.current.bridge.conversationId).toBe('thread-c'));
    expect(result.current.location.search).toBe('');
    expect(result.current.bridge.source).toBe('drawer');
  });

  it('explains unsupported drawer selections without substituting another thread', async () => {
    const { result } = renderHook(() => useConversationSelection(), {
      wrapper: wrapper('/agents/conversations?open=scoped-thread'),
    });
    await waitFor(() => expect(result.current.conversationId).toBe('scoped-thread'));
    act(() => {
      result.current.registerHint('scoped-thread', { scopeType: 'project', state: 'ACTIVE' });
    });
    await waitFor(() => {
      expect(result.current.drawerIssue).toBe('unsupported_scope');
      expect(result.current.fullViewIssue).toBeNull();
      expect(result.current.conversationId).toBe('scoped-thread');
    });
  });

  it('marks missing threads and ignores duplicate drawer echoes', async () => {
    const { result } = renderHook(() => useConversationSelection(), {
      wrapper: wrapper('/agents/conversations'),
    });
    await waitFor(() => expect(result.current.onConversationsPage).toBe(true));
    act(() => {
      result.current.applySelection('thread-e', 'drawer', {
        scopeType: 'freeform',
        state: 'ACTIVE',
      });
    });
    await waitFor(() => expect(result.current.source).toBe('drawer'));
    act(() => {
      result.current.applySelection('thread-e', 'drawer', {
        scopeType: 'freeform',
        state: 'ACTIVE',
      });
    });
    expect(result.current.conversationId).toBe('thread-e');
    expect(result.current.source).toBe('drawer');
    act(() => {
      result.current.applySelection('missing-thread', 'drawer', null);
    });
    await waitFor(() => {
      expect(result.current.conversationId).toBe('missing-thread');
      expect(result.current.drawerIssue).toBe('missing');
      expect(result.current.fullViewIssue).toBe('missing');
    });
  });

  it('builds a reloadable full-view path for the selected thread', async () => {
    const { result } = renderHook(() => useConversationSelection(), {
      wrapper: wrapper('/agents/conversations?open=thread-d'),
    });
    await waitFor(() => expect(result.current.conversationId).toBe('thread-d'));
    expect(result.current.conversationsOpenPath('thread-d')).toBe(
      '/agents/conversations?open=thread-d',
    );
  });
});

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHubTypingFrame } from '../../shared/agent-hub-live';
import { AgentHubTipsContext } from './components/AgentHubTipsContext';
import { useConversationTyping } from './useConversationTyping';

describe('useConversationTyping', () => {
  it('tracks typing labels and clears them when active becomes false', () => {
    let callbacks: { onTyping?: (frame: AgentHubTypingFrame) => void } = {};
    const subscribeConversation = vi.fn((_id: string, next: typeof callbacks) => {
      callbacks = next;
      return () => undefined;
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AgentHubTipsContext.Provider
        value={{ subscribe: () => () => undefined, subscribeConversation, reconnecting: false }}
      >
        {children}
      </AgentHubTipsContext.Provider>
    );

    const { result } = renderHook(() => useConversationTyping('conv-1', true), { wrapper });
    expect(result.current).toEqual([]);

    act(() => {
      callbacks.onTyping?.({
        kind: 'typing',
        conversationId: 'conv-1',
        agentLabel: 'reviewer',
        active: true,
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
      });
    });
    expect(result.current).toEqual(['reviewer']);

    act(() => {
      callbacks.onTyping?.({
        kind: 'typing',
        conversationId: 'conv-1',
        agentLabel: 'reviewer',
        active: false,
        expiresAt: null,
      });
    });
    expect(result.current).toEqual([]);
  });

  it('clears typing when the server expiry instant is already past', () => {
    let callbacks: { onTyping?: (frame: AgentHubTypingFrame) => void } = {};
    const subscribeConversation = vi.fn((_id: string, next: typeof callbacks) => {
      callbacks = next;
      return () => undefined;
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AgentHubTipsContext.Provider
        value={{ subscribe: () => () => undefined, subscribeConversation, reconnecting: false }}
      >
        {children}
      </AgentHubTipsContext.Provider>
    );

    const { result } = renderHook(() => useConversationTyping('conv-1', true), { wrapper });

    act(() => {
      callbacks.onTyping?.({
        kind: 'typing',
        conversationId: 'conv-1',
        agentLabel: 'reviewer',
        active: true,
        expiresAt: '2020-01-01T00:00:00.000Z',
      });
    });
    expect(result.current).toEqual([]);
  });
});

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentHubTipsContext, useAgentHubTipsSubscribe } from './components/AgentHubTipsContext';

describe('AgentHubTipsContext', () => {
  it('returns null outside a provider and the subscribe function inside one', () => {
    expect(renderHook(() => useAgentHubTipsSubscribe()).result.current).toBeNull();

    const subscribe = () => () => undefined;
    const connection = { subscribe, subscribeConversation: () => () => undefined, reconnecting: false };
    const { result } = renderHook(() => useAgentHubTipsSubscribe(), {
      wrapper: ({ children }) => (
        <AgentHubTipsContext.Provider value={connection}>{children}</AgentHubTipsContext.Provider>
      ),
    });
    expect(result.current).toBe(subscribe);
  });
});

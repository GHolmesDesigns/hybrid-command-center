import { renderHook, act } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHubTipPayload } from '../../shared/agent-hub-sse';
import {
  useAgentHubTips,
  useDebouncedAgentHubTip,
  type AgentHubTipListener,
} from './useAgentHubTips';

describe('useDebouncedAgentHubTip', () => {
  it('debounces callbacks for one feed and ignores others', () => {
    vi.useFakeTimers();
    let trigger: AgentHubTipListener | null = null;
    const subscribe = (listener: AgentHubTipListener) => {
      trigger = listener;
      return () => {
        trigger = null;
      };
    };
    const hits: AgentHubTipPayload[] = [];
    renderHook(() =>
      useDebouncedAgentHubTip(subscribe, 'notifications', (tip) => hits.push(tip), 300),
    );

    act(() => {
      trigger?.({ feeds: ['notifications'] });
      trigger?.({ feeds: ['notifications'] });
    });
    expect(hits).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(hits).toHaveLength(1);

    act(() => {
      trigger?.({ feeds: ['conversations'], conversationId: 'thread-1' });
      vi.advanceTimersByTime(300);
    });
    expect(hits).toHaveLength(1);

    vi.useRealTimers();
  });
});

describe('useAgentHubTips', () => {
  it('dispatches parsed tips and reconnects after stream errors', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: (() => void) | null;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    class MockEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor(public url: string) {
        instances.push(this);
      }
    }
    const Original = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    function Probe({ enabled }: { enabled: boolean }) {
      const { subscribe } = useAgentHubTips(enabled);
      const [last, setLast] = useState<AgentHubTipPayload | null>(null);
      useEffect(() => subscribe((tip) => setLast(tip)), [subscribe]);
      return last;
    }

    const { result } = renderHook(() => Probe({ enabled: true }));
    act(() => {
      instances[0]?.onmessage?.({ data: JSON.stringify({ feeds: ['notifications'] }) } as MessageEvent);
      instances[0]?.onmessage?.({ data: '{not-json' } as MessageEvent);
    });
    expect(result.current).toEqual({ feeds: ['notifications'] });

    act(() => {
      instances[0]?.onerror?.();
      vi.advanceTimersByTime(5000);
    });
    expect(instances).toHaveLength(2);

    globalThis.EventSource = Original;
    vi.useRealTimers();
  });

  it('does not open EventSource when disabled', () => {
    const Original = globalThis.EventSource;
    const construct = vi.fn();
    class MockEventSource {
      constructor(url: string) {
        construct(url);
      }
      close() {}
      onmessage = null;
      onerror = null;
    }
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    renderHook(() => useAgentHubTips(false));
    expect(construct).not.toHaveBeenCalled();
    globalThis.EventSource = Original;
  });
});

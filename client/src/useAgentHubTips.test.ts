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
  it('dispatches parsed wake tips, ignores stale seq, and reconnects after close', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      onclose: (() => void) | null;
      onerror: (() => void) | null;
      close: ReturnType<typeof vi.fn>;
      url: string;
    }> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn(() => {
        this.readyState = 3;
        this.onclose?.();
      });
      constructor(public url: string) {
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    function Probe({ enabled }: { enabled: boolean }) {
      const { subscribe } = useAgentHubTips(enabled);
      const [last, setLast] = useState<AgentHubTipPayload | null>(null);
      useEffect(() => subscribe((tip) => setLast(tip)), [subscribe]);
      return last;
    }

    const { result } = renderHook(() => Probe({ enabled: true }));
    act(() => {
      instances[0]?.onmessage?.({
        data: JSON.stringify({ kind: 'wake', seq: 2, feeds: ['notifications'] }),
      } as MessageEvent);
      instances[0]?.onmessage?.({
        data: JSON.stringify({ kind: 'wake', seq: 1, feeds: ['notifications'] }),
      } as MessageEvent);
      instances[0]?.onmessage?.({ data: '{not-json' } as MessageEvent);
    });
    expect(result.current).toEqual({ feeds: ['notifications'] });

    act(() => {
      instances[0]?.onclose?.();
      vi.advanceTimersByTime(1000);
    });
    expect(instances).toHaveLength(2);

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('does not open WebSocket when disabled', () => {
    const Original = globalThis.WebSocket;
    const construct = vi.fn();
    class MockWebSocket {
      constructor(url: string) {
        construct(url);
      }
      close() {}
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
    }
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    renderHook(() => useAgentHubTips(false));
    expect(construct).not.toHaveBeenCalled();
    globalThis.WebSocket = Original;
  });
});

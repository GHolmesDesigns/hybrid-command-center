import { renderHook, act } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHubTipPayload } from '../../shared/agent-hub-tips';
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

  it('debounces coordination feed tips', () => {
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
      useDebouncedAgentHubTip(subscribe, 'coordination', (tip) => hits.push(tip), 300),
    );

    act(() => {
      trigger?.({ feeds: ['coordination'] });
      vi.advanceTimersByTime(300);
    });
    expect(hits).toEqual([{ feeds: ['coordination'] }]);

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

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('routes assistant delta and turn-state frames to conversation subscribers', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      onclose: (() => void) | null;
      close: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    }> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor(..._args: [string]) {
        void _args;
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send = vi.fn();
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const deltas: string[] = [];
    const states: string[] = [];
    const { result } = renderHook(() => useAgentHubTips(true));
    act(() => {
      result.current.subscribeConversation('conv-1', {
        onDelta: (frame) => deltas.push(frame.delta),
        onTurnState: (frame) => states.push(frame.state),
      });
    });
    act(() => {
      instances[0]?.onmessage?.({
        data: JSON.stringify({
          kind: 'assistant_delta',
          turnId: 'turn-1',
          conversationId: 'conv-1',
          delta: 'Hello',
        }),
      } as MessageEvent);
      instances[0]?.onmessage?.({
        data: JSON.stringify({
          kind: 'assistant_turn_state',
          turnId: 'turn-1',
          conversationId: 'conv-1',
          state: 'awaiting_approval',
        }),
      } as MessageEvent);
    });
    expect(deltas).toEqual(['Hello']);
    expect(states).toEqual(['awaiting_approval']);
    expect(instances[0]?.send).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'subscribe', conversationId: 'conv-1' }),
    );

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('unsubscribes from a conversation and ignores other conversation frames', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      send: ReturnType<typeof vi.fn>;
    }> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send = vi.fn();
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const deltas: string[] = [];
    const { result } = renderHook(() => useAgentHubTips(true));
    let unsubscribe = () => {};
    act(() => {
      unsubscribe = result.current.subscribeConversation('conv-1', {
        onDelta: (frame) => deltas.push(frame.delta),
      });
    });
    act(() => {
      instances[0]?.onmessage?.({
        data: JSON.stringify({
          kind: 'assistant_delta',
          turnId: 'turn-1',
          conversationId: 'conv-2',
          delta: 'wrong',
        }),
      } as MessageEvent);
    });
    expect(deltas).toEqual([]);
    act(() => unsubscribe());
    expect(instances[0]?.send).toHaveBeenCalledWith(
      JSON.stringify({ kind: 'unsubscribe', conversationId: 'conv-1' }),
    );

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('ignores malformed websocket payloads and stale wake sequences', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send = vi.fn();
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const tips: string[] = [];
    const { result } = renderHook(() => useAgentHubTips(true));
    act(() => {
      result.current.subscribe((tip) => tips.push(tip.feeds.join(',')));
    });
    act(() => {
      instances[0]?.onmessage?.({ data: '{not-json' } as MessageEvent);
      instances[0]?.onmessage?.({
        data: JSON.stringify({ kind: 'wake', seq: 2, feeds: ['conversations'] }),
      } as MessageEvent);
      instances[0]?.onmessage?.({
        data: JSON.stringify({ kind: 'wake', seq: 1, feeds: ['conversations'] }),
      } as MessageEvent);
    });
    expect(tips).toEqual(['conversations']);

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('routes turn-state frames when no delta handler is registered', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send = vi.fn();
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const states: string[] = [];
    const { result } = renderHook(() => useAgentHubTips(true));
    act(() => {
      result.current.subscribeConversation('conv-1', {
        onTurnState: (frame) => states.push(frame.state),
      });
    });
    act(() => {
      instances[0]?.onmessage?.({
        data: JSON.stringify({
          kind: 'assistant_turn_state',
          turnId: 'turn-1',
          conversationId: 'conv-1',
          state: 'finished',
        }),
      } as MessageEvent);
    });
    expect(states).toEqual(['finished']);

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('dispatches wake tips that include a conversation id', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send = vi.fn();
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const tips: AgentHubTipPayload[] = [];
    const { result } = renderHook(() => useAgentHubTips(true));
    act(() => {
      result.current.subscribe((tip) => tips.push(tip));
    });
    act(() => {
      instances[0]?.onmessage?.({
        data: JSON.stringify({
          kind: 'wake',
          seq: 1,
          feeds: ['conversations'],
          conversationId: 'conv-wake',
        }),
      } as MessageEvent);
    });
    expect(tips).toEqual([{ feeds: ['conversations'], conversationId: 'conv-wake' }]);

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('closes the socket when onerror fires', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onerror: (() => void) | null;
      close: ReturnType<typeof vi.fn>;
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
      });
      constructor() {
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send = vi.fn();
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    renderHook(() => useAgentHubTips(true));
    act(() => {
      instances[0]?.onerror?.();
    });
    expect(instances[0]?.close).toHaveBeenCalled();

    globalThis.WebSocket = Original;
    vi.useRealTimers();
  });

  it('dispatches coordination wake tips to subscribers', () => {
    vi.useFakeTimers();
    const instances: Array<{
      onopen: (() => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];
    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor() {
        instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send = vi.fn();
    }
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    const tips: AgentHubTipPayload[] = [];
    const { result } = renderHook(() => useAgentHubTips(true));
    act(() => {
      result.current.subscribe((tip) => tips.push(tip));
    });
    act(() => {
      instances[0]?.onmessage?.({
        data: JSON.stringify({ kind: 'wake', seq: 1, feeds: ['coordination'] }),
      } as MessageEvent);
    });
    expect(tips).toEqual([{ feeds: ['coordination'] }]);

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

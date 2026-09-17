import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isAgentHubTipPayload,
  type AgentHubTipFeed,
  type AgentHubTipPayload,
} from '../../shared/agent-hub-sse';
import { AGENT_HUB_WS_PATH, isAgentHubWakeFrame } from '../../shared/agent-hub-live';

export type AgentHubTipListener = (tip: AgentHubTipPayload) => void;

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const RECONNECT_BANNER_FAILURES = 3;

function agentHubWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${AGENT_HUB_WS_PATH}`;
}

export type AgentHubLiveConnection = {
  subscribe: (listener: AgentHubTipListener) => () => void;
  /** True after repeated reconnect failures — navigation and HTTP refresh still work. */
  reconnecting: boolean;
};

export function useAgentHubTips(enabled: boolean): AgentHubLiveConnection {
  const listenersRef = useRef(new Set<AgentHubTipListener>());
  const [reconnecting, setReconnecting] = useState(false);

  const subscribe = useCallback((listener: AgentHubTipListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let stopped = false;
    let retryMs = INITIAL_RETRY_MS;
    let failureCount = 0;
    let lastSeenSeq = 0;
    let openedOnce = false;

    const dispatch = (tip: AgentHubTipPayload) => {
      for (const listener of listenersRef.current) {
        listener(tip);
      }
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      failureCount += 1;
      if (failureCount >= RECONNECT_BANNER_FAILURES) setReconnecting(true);
      retryTimer = window.setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(agentHubWsUrl());
      socket.onopen = () => {
        openedOnce = true;
        failureCount = 0;
        retryMs = INITIAL_RETRY_MS;
        setReconnecting(false);
      };
      socket.onmessage = (event) => {
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          if (!isAgentHubWakeFrame(parsed)) return;
          if (parsed.seq <= lastSeenSeq) return;
          lastSeenSeq = parsed.seq;
          const tip = {
            feeds: parsed.feeds,
            ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
          };
          if (isAgentHubTipPayload(tip)) dispatch(tip);
        } catch {
          // Ignore malformed wake frames; the next HTTP reread remains authoritative.
        }
      };
      socket.onclose = () => {
        socket = null;
        if (!stopped && openedOnce) scheduleReconnect();
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();
    return () => {
      stopped = true;
      setReconnecting(false);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [enabled]);

  return { subscribe, reconnecting };
}

export function useDebouncedAgentHubTip(
  subscribe: ((listener: AgentHubTipListener) => () => void) | null,
  feed: AgentHubTipFeed,
  callback: (tip: AgentHubTipPayload) => void,
  delayMs = 300,
) {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!subscribe) return;
    let timer: number | undefined;
    return subscribe((tip) => {
      if (!tip.feeds.includes(feed)) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => callbackRef.current(tip), delayMs);
    });
  }, [subscribe, feed, delayMs]);
}

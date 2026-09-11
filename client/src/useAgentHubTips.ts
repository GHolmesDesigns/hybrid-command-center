import { useCallback, useEffect, useRef } from 'react';
import {
  isAgentHubTipPayload,
  type AgentHubTipFeed,
  type AgentHubTipPayload,
} from '../../shared/agent-hub-sse';

export type AgentHubTipListener = (tip: AgentHubTipPayload) => void;

const TIP_PATH = '/api/agent-hub/tips';
const RETRY_MS = 5_000;

export function useAgentHubTips(enabled: boolean) {
  const listenersRef = useRef(new Set<AgentHubTipListener>());

  const subscribe = useCallback((listener: AgentHubTipListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let stopped = false;

    const dispatch = (tip: AgentHubTipPayload) => {
      for (const listener of listenersRef.current) {
        listener(tip);
      }
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(TIP_PATH);
      source.onmessage = (event) => {
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (isAgentHubTipPayload(parsed)) dispatch(parsed);
        } catch {
          // Ignore malformed tip frames; the next HTTP reread remains authoritative.
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (!stopped) retryTimer = window.setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled]);

  return { subscribe };
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

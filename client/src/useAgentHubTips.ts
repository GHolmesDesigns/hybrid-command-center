import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isAgentHubTipPayload,
  type AgentHubTipFeed,
  type AgentHubTipPayload,
} from '../../shared/agent-hub-sse';
import {
  AGENT_HUB_WS_PATH,
  isAgentHubAssistantDeltaFrame,
  isAgentHubAssistantTurnStateFrame,
  isAgentHubWakeFrame,
  type AgentHubAssistantDeltaFrame,
  type AgentHubAssistantTurnStateFrame,
  type AgentHubClientFrame,
} from '../../shared/agent-hub-live';

export type AgentHubTipListener = (tip: AgentHubTipPayload) => void;

export type AssistantStreamCallbacks = {
  onDelta?: (frame: AgentHubAssistantDeltaFrame) => void;
  onTurnState?: (frame: AgentHubAssistantTurnStateFrame) => void;
};

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const RECONNECT_BANNER_FAILURES = 3;

function agentHubWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${AGENT_HUB_WS_PATH}`;
}

export type AgentHubLiveConnection = {
  subscribe: (listener: AgentHubTipListener) => () => void;
  subscribeConversation: (
    conversationId: string,
    callbacks: AssistantStreamCallbacks,
  ) => () => void;
  /** True after repeated reconnect failures — navigation and HTTP refresh still work. */
  reconnecting: boolean;
};

export function useAgentHubTips(enabled: boolean): AgentHubLiveConnection {
  const listenersRef = useRef(new Set<AgentHubTipListener>());
  const conversationSubsRef = useRef(new Map<string, Set<AssistantStreamCallbacks>>());
  const subscribedIdsRef = useRef(new Set<string>());
  const socketRef = useRef<WebSocket | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const sendFrame = useCallback((frame: AgentHubClientFrame) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }, []);

  const syncConversationSubscriptions = useCallback(() => {
    for (const conversationId of subscribedIdsRef.current) {
      sendFrame({ kind: 'subscribe', conversationId });
    }
  }, [sendFrame]);

  const subscribe = useCallback((listener: AgentHubTipListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const subscribeConversation = useCallback(
    (conversationId: string, callbacks: AssistantStreamCallbacks) => {
      let set = conversationSubsRef.current.get(conversationId);
      if (!set) {
        set = new Set();
        conversationSubsRef.current.set(conversationId, set);
        subscribedIdsRef.current.add(conversationId);
        sendFrame({ kind: 'subscribe', conversationId });
      }
      set.add(callbacks);
      return () => {
        const current = conversationSubsRef.current.get(conversationId);
        if (!current) return;
        current.delete(callbacks);
        if (current.size === 0) {
          conversationSubsRef.current.delete(conversationId);
          subscribedIdsRef.current.delete(conversationId);
          sendFrame({ kind: 'unsubscribe', conversationId });
        }
      };
    },
    [sendFrame],
  );

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let stopped = false;
    let retryMs = INITIAL_RETRY_MS;
    let failureCount = 0;
    let lastSeenSeq = 0;
    let openedOnce = false;

    const dispatchTip = (tip: AgentHubTipPayload) => {
      for (const listener of listenersRef.current) {
        listener(tip);
      }
    };

    const dispatchAssistant = (conversationId: string, frame: unknown) => {
      const subs = conversationSubsRef.current.get(conversationId);
      if (!subs?.size) return;
      if (isAgentHubAssistantDeltaFrame(frame)) {
        for (const callbacks of subs) callbacks.onDelta?.(frame);
        return;
      }
      if (isAgentHubAssistantTurnStateFrame(frame)) {
        for (const callbacks of subs) callbacks.onTurnState?.(frame);
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
      socketRef.current = socket;
      socket.onopen = () => {
        openedOnce = true;
        failureCount = 0;
        retryMs = INITIAL_RETRY_MS;
        setReconnecting(false);
        syncConversationSubscriptions();
      };
      socket.onmessage = (event) => {
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          if (isAgentHubWakeFrame(parsed)) {
            if (parsed.seq <= lastSeenSeq) return;
            lastSeenSeq = parsed.seq;
            const tip = {
              feeds: parsed.feeds,
              ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
            };
            if (isAgentHubTipPayload(tip)) dispatchTip(tip);
            return;
          }
          if (isAgentHubAssistantDeltaFrame(parsed)) {
            dispatchAssistant(parsed.conversationId, parsed);
            return;
          }
          if (isAgentHubAssistantTurnStateFrame(parsed)) {
            dispatchAssistant(parsed.conversationId, parsed);
          }
        } catch {
          // Ignore malformed frames; the next HTTP reread remains authoritative.
        }
      };
      socket.onclose = () => {
        socketRef.current = null;
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
      socketRef.current = null;
      socket?.close();
    };
  }, [enabled, syncConversationSubscriptions]);

  return { subscribe, subscribeConversation, reconnecting };
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

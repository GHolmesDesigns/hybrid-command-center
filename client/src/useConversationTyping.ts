import { useEffect, useRef, useState } from 'react';
import type { AgentHubTypingFrame } from '../../shared/agent-hub-live';
import { useAgentHubLiveConnection } from './components/AgentHubTipsContext';

/** Ephemeral agent typing labels for one open thread (LC-P5 / #675). */
export function useConversationTyping(conversationId: string | null, enabled: boolean): string[] {
  const agentHubLive = useAgentHubLiveConnection();
  const [typingByLabel, setTypingByLabel] = useState<Record<string, true>>({});
  const expiryTimers = useRef(new Map<string, number>());

  useEffect(() => {
    if (!conversationId || !enabled || !agentHubLive) {
      setTypingByLabel({});
      return;
    }

    const clearTimer = (label: string) => {
      const timerId = expiryTimers.current.get(label);
      if (timerId !== undefined) window.clearTimeout(timerId);
      expiryTimers.current.delete(label);
    };

    const clearLabel = (label: string) => {
      clearTimer(label);
      setTypingByLabel((current) => {
        if (!current[label]) return current;
        const next = { ...current };
        delete next[label];
        return next;
      });
    };

    const scheduleExpiry = (label: string, expiresAt: string | null) => {
      clearTimer(label);
      if (!expiresAt) return;
      const delay = Date.parse(expiresAt) - Date.now();
      if (delay <= 0) {
        clearLabel(label);
        return;
      }
      expiryTimers.current.set(
        label,
        window.setTimeout(() => clearLabel(label), delay + 50),
      );
    };

    const onTyping = (frame: AgentHubTypingFrame) => {
      const key = frame.agentLabel.toLowerCase();
      if (!frame.active) {
        clearLabel(key);
        return;
      }
      setTypingByLabel((current) => ({ ...current, [key]: true }));
      scheduleExpiry(key, frame.expiresAt);
    };

    const unsubscribe = agentHubLive.subscribeConversation(conversationId, { onTyping });
    return () => {
      unsubscribe();
      for (const timerId of expiryTimers.current.values()) window.clearTimeout(timerId);
      expiryTimers.current.clear();
      setTypingByLabel({});
    };
  }, [agentHubLive, conversationId, enabled]);

  return Object.keys(typingByLabel);
}

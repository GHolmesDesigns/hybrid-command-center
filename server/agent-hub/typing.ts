/**
 * Ephemeral per-thread agent typing (LC-P5 / #675).
 *
 * Never persisted — TTL-backed in-memory state broadcast over WebSocket to subscribed operators.
 */
import { AGENT_HUB_TYPING_TTL_MS, type AgentHubTypingFrame } from '../../shared/agent-hub-live.ts';

type TypingEntry = {
  agentLabel: string;
  expiresAt: number;
};

export type AgentHubTypingBroadcast = (conversationId: string, frame: AgentHubTypingFrame) => void;

export class AgentHubTypingRegistry {
  private readonly byConversation = new Map<string, Map<string, TypingEntry>>();
  private broadcast: AgentHubTypingBroadcast | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  attachBroadcast(handler: AgentHubTypingBroadcast): void {
    this.broadcast = handler;
  }

  setTyping(conversationId: string, agentLabel: string, active: boolean): AgentHubTypingFrame {
    let conversation = this.byConversation.get(conversationId);
    if (!conversation) {
      conversation = new Map();
      this.byConversation.set(conversationId, conversation);
    }

    if (active) {
      const expiresAt = this.now() + AGENT_HUB_TYPING_TTL_MS;
      conversation.set(agentLabel, { agentLabel, expiresAt });
      this.scheduleExpiry();
    } else {
      conversation.delete(agentLabel);
      if (conversation.size === 0) this.byConversation.delete(conversationId);
    }

    const frame = this.frameFor(conversationId, agentLabel, active);
    this.broadcast?.(conversationId, frame);
    return frame;
  }

  clearForAgent(agentLabel: string): void {
    for (const [conversationId, conversation] of this.byConversation) {
      if (!conversation.has(agentLabel)) continue;
      conversation.delete(agentLabel);
      if (conversation.size === 0) this.byConversation.delete(conversationId);
      this.broadcast?.(conversationId, this.frameFor(conversationId, agentLabel, false));
    }
  }

  dispose(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.byConversation.clear();
    this.broadcast = null;
  }

  private frameFor(
    conversationId: string,
    agentLabel: string,
    active: boolean,
  ): AgentHubTypingFrame {
    if (!active) {
      return { kind: 'typing', conversationId, agentLabel, active: false, expiresAt: null };
    }
    const entry = this.byConversation.get(conversationId)?.get(agentLabel);
    return {
      kind: 'typing',
      conversationId,
      agentLabel,
      active: true,
      expiresAt: entry ? new Date(entry.expiresAt).toISOString() : null,
    };
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expireStale();
    }, 250);
    this.expiryTimer.unref?.();
  }

  private expireStale(): void {
    const nowMs = this.now();
    let rescheduled = false;
    for (const [conversationId, conversation] of this.byConversation) {
      for (const [agentLabel, entry] of conversation) {
        if (entry.expiresAt > nowMs) {
          rescheduled = true;
          continue;
        }
        conversation.delete(agentLabel);
        this.broadcast?.(conversationId, this.frameFor(conversationId, agentLabel, false));
      }
      if (conversation.size === 0) this.byConversation.delete(conversationId);
    }
    if (rescheduled) this.scheduleExpiry();
  }
}

let registeredTyping: AgentHubTypingRegistry | null = null;

export function registerAgentHubTypingRegistry(registry: AgentHubTypingRegistry | null): void {
  registeredTyping = registry;
}

export function setAgentHubConversationTyping(
  conversationId: string,
  agentLabel: string,
  active: boolean,
): AgentHubTypingFrame | null {
  return registeredTyping?.setTyping(conversationId, agentLabel, active) ?? null;
}

export function clearAgentHubTypingForAgent(agentLabel: string): void {
  registeredTyping?.clearForAgent(agentLabel);
}

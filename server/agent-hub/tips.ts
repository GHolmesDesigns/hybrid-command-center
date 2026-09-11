/**
 * Process-local Agent Hub tip fan-out (C219 / #605).
 *
 * Conversation and notification writers call the helpers here. The HTTP app installs one bridge
 * that forwards tips into the shell SSE registry (replaced on each `createApp`, so tests do not
 * stack listeners). Payloads name feeds only — clients reread HTTP state.
 */
import type { AgentHubTipFeed, AgentHubTipPayload } from '../../shared/agent-hub-sse.ts';
import { isAgentHubTipPayload } from '../../shared/agent-hub-sse.ts';

export type AgentHubTipListener = (tip: AgentHubTipPayload) => void;

export class AgentHubTipRegistry {
  private readonly listeners = new Set<AgentHubTipListener>();

  subscribe(listener: AgentHubTipListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(raw: AgentHubTipPayload): void {
    if (!isAgentHubTipPayload(raw)) return;
    for (const listener of this.listeners) {
      try {
        listener(raw);
      } catch {
        // A broken listener must not block other subscribers or the write that triggered the tip.
      }
    }
  }
}

/** Single app-owned bridge — last `setAgentHubTipBridge` wins. */
let bridge: AgentHubTipRegistry | null = null;

const extraListeners = new Set<AgentHubTipListener>();

export function setAgentHubTipBridge(registry: AgentHubTipRegistry | null): void {
  bridge = registry;
}

/** Extra listeners (unit / integration tests). Prefer the bridge for production wiring. */
export function onAgentHubTip(listener: AgentHubTipListener): () => void {
  extraListeners.add(listener);
  return () => {
    extraListeners.delete(listener);
  };
}

function emit(tip: AgentHubTipPayload): void {
  if (!isAgentHubTipPayload(tip)) return;
  if (bridge) {
    try {
      bridge.publish(tip);
    } catch {
      // A broken bridge must not block the write that triggered the tip.
    }
  }
  for (const listener of extraListeners) {
    try {
      listener(tip);
    } catch {
      // A broken listener must not block other subscribers.
    }
  }
}

export function tipAgentHubFeeds(
  feeds: AgentHubTipFeed[],
  options: { conversationId?: string } = {},
): void {
  if (feeds.length === 0) return;
  emit({
    feeds: [...new Set(feeds)],
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
  });
}

export function tipAgentHubConversation(conversationId: string): void {
  tipAgentHubFeeds(['conversations'], { conversationId });
}

export function tipAgentHubNotifications(): void {
  tipAgentHubFeeds(['notifications']);
}

/** Test helper — clears bridge and listeners between suites. */
export function resetAgentHubTipsForTests(): void {
  bridge = null;
  extraListeners.clear();
}

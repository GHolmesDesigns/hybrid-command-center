/**
 * Agent Hub WebSocket live channel frame vocabulary (C236 / #669).
 *
 * Frames wake the shell or carry non-authoritative assistant streaming state. Persisted messages,
 * counts, and snapshots stay on HTTP — the same discipline as C219 SSE tips.
 */
import type { AgentHubTipFeed, AgentHubTipPayload } from './agent-hub-sse.ts';

export const AGENT_HUB_WS_PATH = '/api/agent-hub/ws';

export const AGENT_HUB_CLIENT_FRAME_KINDS = ['subscribe', 'unsubscribe', 'ping'] as const;
export type AgentHubClientFrameKind = (typeof AGENT_HUB_CLIENT_FRAME_KINDS)[number];

export const AGENT_HUB_SERVER_FRAME_KINDS = [
  'wake',
  'pong',
  'assistant_delta',
  'assistant_turn_state',
] as const;
export type AgentHubServerFrameKind = (typeof AGENT_HUB_SERVER_FRAME_KINDS)[number];

export type AgentHubSubscribeFrame = {
  kind: 'subscribe';
  conversationId: string;
};

export type AgentHubUnsubscribeFrame = {
  kind: 'unsubscribe';
  conversationId: string;
};

export type AgentHubPingFrame = {
  kind: 'ping';
};

export type AgentHubClientFrame =
  AgentHubSubscribeFrame | AgentHubUnsubscribeFrame | AgentHubPingFrame;

/** Server wake frame — names feeds and optional conversation id only. */
export type AgentHubWakeFrame = {
  kind: 'wake';
  seq: number;
  feeds: AgentHubTipFeed[];
  conversationId?: string;
};

export type AgentHubPongFrame = {
  kind: 'pong';
};

/** Phase 3 — streaming assistant text; not routed in Phase 1. */
export type AgentHubAssistantDeltaFrame = {
  kind: 'assistant_delta';
  turnId: string;
  conversationId: string;
  delta: string;
};

export type AgentHubAssistantTurnState =
  'started' | 'awaiting_approval' | 'finished' | 'failed' | 'cancelled';

/** Phase 3 — assistant turn UI state; not routed in Phase 1. */
export type AgentHubAssistantTurnStateFrame = {
  kind: 'assistant_turn_state';
  turnId: string;
  conversationId: string;
  state: AgentHubAssistantTurnState;
};

export type AgentHubServerFrame =
  | AgentHubWakeFrame
  | AgentHubPongFrame
  | AgentHubAssistantDeltaFrame
  | AgentHubAssistantTurnStateFrame;

export const AGENT_HUB_WS_MAX_INBOUND_BYTES = 4_096;
export const AGENT_HUB_WS_MAX_INBOUND_MESSAGES_PER_SECOND = 20;
/** Shorter than typical reverse-proxy idle timeouts — see deploy/aws/README.md. */
export const AGENT_HUB_WS_SERVER_PING_INTERVAL_MS = 30_000;

const isClientKind = (value: unknown): value is AgentHubClientFrameKind =>
  typeof value === 'string' && (AGENT_HUB_CLIENT_FRAME_KINDS as readonly string[]).includes(value);

const isConversationId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

export function parseAgentHubClientFrame(raw: unknown): AgentHubClientFrame | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isClientKind(record.kind)) return null;
  if (record.kind === 'ping') return { kind: 'ping' };
  if (!isConversationId(record.conversationId)) return null;
  if (record.kind === 'subscribe') {
    return { kind: 'subscribe', conversationId: record.conversationId };
  }
  return { kind: 'unsubscribe', conversationId: record.conversationId };
}

export function agentHubWakeFromTip(seq: number, tip: AgentHubTipPayload): AgentHubWakeFrame {
  return {
    kind: 'wake',
    seq,
    feeds: tip.feeds,
    ...(tip.conversationId ? { conversationId: tip.conversationId } : {}),
  };
}

export function isAgentHubWakeFrame(value: unknown): value is AgentHubWakeFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'wake') return false;
  if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return false;
  if (!Array.isArray(record.feeds) || record.feeds.length === 0) return false;
  if (record.conversationId !== undefined && typeof record.conversationId !== 'string')
    return false;
  return true;
}

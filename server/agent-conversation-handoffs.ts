import type { Db } from './db.ts';
import type { AgentHandoffSource } from '../shared/agent-conversations.ts';

export function handoffSourcesForIds(
  db: Db,
  handoffIds: readonly string[],
): Map<string, AgentHandoffSource> {
  if (handoffIds.length === 0) return new Map();
  const placeholders = handoffIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT h.handoff_id, m.conversation_id, h.message_id
       FROM agent_conversation_message_handoffs h
       JOIN agent_conversation_messages m ON m.id = h.message_id
       WHERE h.handoff_id IN (${placeholders})`,
    )
    .all(...handoffIds) as {
    handoff_id: string;
    conversation_id: string;
    message_id: string;
  }[];
  return new Map(
    rows.map((row) => [
      row.handoff_id,
      { conversationId: row.conversation_id, messageId: row.message_id },
    ]),
  );
}

export function applyHandoffSources<T extends { id: string }>(
  db: Db,
  handoffs: T[],
): Array<T & { sourceConversationId: string | null; sourceMessageId: string | null }> {
  const sources = handoffSourcesForIds(
    db,
    handoffs.map((handoff) => handoff.id),
  );
  return handoffs.map((handoff) => {
    const source = sources.get(handoff.id);
    return {
      ...handoff,
      sourceConversationId: source?.conversationId ?? null,
      sourceMessageId: source?.messageId ?? null,
    };
  });
}

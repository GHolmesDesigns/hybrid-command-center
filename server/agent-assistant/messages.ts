import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { setSetting } from '../drive/service.ts';
import { tipAgentHubConversation } from '../agent-hub/tips.ts';
import { ASSISTANT_AGENT_LABEL } from '../../shared/mcp-agent-registry.ts';

const PIPELINE_INSERT_KEY = 'assistant_pipeline_insert';

/** Internal-only insert that bypasses the HTTP/MCP assistant sender_kind guard. */
export function insertAssistantMessage(
  db: Db,
  conversationId: string,
  body: string,
  now = new Date(),
): string {
  const messageId = crypto.randomUUID();
  const instant = now.toISOString();
  transaction(db, () => {
    setSetting(db, PIPELINE_INSERT_KEY, '1');
    try {
      db.prepare(
        `INSERT INTO agent_conversation_messages(
           id, conversation_id, sender_label, sent_at, body, sender_provenance, sender_kind, thought_summary
         ) VALUES(?,?,?,?,?,?,?,NULL)`,
      ).run(
        messageId,
        conversationId,
        ASSISTANT_AGENT_LABEL,
        instant,
        body,
        'VERIFIED',
        'assistant',
      );
      db.prepare('UPDATE agent_conversations SET updated_at=? WHERE id=?').run(instant, conversationId);
    } finally {
      db.prepare('DELETE FROM settings WHERE key=?').run(PIPELINE_INSERT_KEY);
    }
  });
  tipAgentHubConversation(conversationId);
  return messageId;
}

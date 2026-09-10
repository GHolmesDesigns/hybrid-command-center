import crypto from 'node:crypto';
import type { Db } from './db.ts';
import { transaction } from './db.ts';
import { redactSecrets } from './integration-log.ts';
import { listAgentDirectory } from './agent-directory.ts';
import type { AgentIdentityProvenance } from '../shared/agent-coordination.ts';
import {
  createConversationSchema,
  messageSchema,
  type AgentConversation,
  type AgentConversationMessage,
  type ConversationState,
  type CreateConversationInput,
  type CursorPage,
} from '../shared/agent-conversations.ts';

const encode = (at: string, id: string) =>
  Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
const decode = (cursor?: string): { at: string; id: string } | null => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value.at !== 'string' || typeof value.id !== 'string') throw new Error();
    return value;
  } catch {
    throw new Error('Invalid conversation cursor.');
  }
};
type ConversationRow = {
  id: string;
  title: string;
  scope_type: string;
  scope_id: string | null;
  state: ConversationState;
  created_at: string;
  updated_at: string;
  message_count: number;
};
const toConversation = (row: ConversationRow, participants: string[]): AgentConversation => ({
  id: row.id,
  title: row.title,
  scope: { type: row.scope_type as AgentConversation['scope']['type'], id: row.scope_id },
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  participants,
  messageCount: row.message_count,
});
const participants = (db: Db, id: string) =>
  (
    db
      .prepare(
        'SELECT agent_label FROM agent_conversation_participants WHERE conversation_id=? ORDER BY agent_label',
      )
      .all(id) as { agent_label: string }[]
  ).map((x) => x.agent_label);
const visible = (db: Db, id: string, actor: string | null) =>
  actor === null ||
  !!db
    .prepare(
      'SELECT 1 FROM agent_conversation_participants WHERE conversation_id=? AND agent_label=?',
    )
    .get(id, actor);
const requireVisible = (db: Db, id: string, actor: string | null) => {
  const row = db.prepare('SELECT * FROM agent_conversations WHERE id=?').get(id) as
    ConversationRow | undefined;
  if (!row || !visible(db, id, actor))
    throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  return row;
};
export function createConversation(
  db: Db,
  raw: CreateConversationInput,
  actor: string,
  now = new Date(),
): AgentConversation {
  const input = createConversationSchema.parse(raw);
  const id = crypto.randomUUID(),
    at = now.toISOString(),
    labels = [...new Set([actor, ...input.participantLabels])];
  transaction(db, () => {
    db.prepare(
      'INSERT INTO agent_conversations(id,title,scope_type,scope_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run(id, input.title, input.scope.type, input.scope.id ?? null, 'ACTIVE', at, at);
    const insert = db.prepare(
      'INSERT INTO agent_conversation_participants(conversation_id,agent_label) VALUES(?,?)',
    );
    for (const label of labels) insert.run(id, label);
  });
  return toConversation(
    db
      .prepare('SELECT *,0 message_count FROM agent_conversations WHERE id=?')
      .get(id) as ConversationRow,
    labels,
  );
}
export function listConversations(
  db: Db,
  actor: string | null,
  raw: unknown = {},
): CursorPage<AgentConversation> {
  const input = raw as { state?: ConversationState; limit?: number; cursor?: string };
  const limit = Math.min(input.limit ?? 50, 100),
    c = decode(input.cursor);
  const rows = db
    .prepare(
      'SELECT c.*, COUNT(m.id) message_count FROM agent_conversations c JOIN agent_conversation_participants p ON p.conversation_id=c.id LEFT JOIN agent_conversation_messages m ON m.conversation_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC',
    )
    .all() as unknown as ConversationRow[];
  const visibleRows = rows.filter(
    (r) =>
      (actor === null || visible(db, r.id, actor)) &&
      (!input.state || r.state === input.state) &&
      (!c || r.updated_at < c.at || (r.updated_at === c.at && r.id < c.id)),
  );
  const page = visibleRows.slice(0, limit + 1);
  const items = page.slice(0, limit).map((r) => toConversation(r, participants(db, r.id)));
  const last = items.at(-1);
  return {
    items,
    nextCursor: page.length > limit && last ? encode(last.updatedAt, last.id) : null,
    hasMore: page.length > limit,
  };
}
export function getConversation(db: Db, id: string, actor: string | null) {
  const row = requireVisible(db, id, actor);
  return toConversation(
    {
      ...row,
      message_count: (
        db
          .prepare('SELECT COUNT(*) count FROM agent_conversation_messages WHERE conversation_id=?')
          .get(id) as { count: number }
      ).count,
    },
    participants(db, id),
  );
}
export function postMessage(
  db: Db,
  id: string,
  actor: string,
  raw: unknown,
  now = new Date(),
): AgentConversationMessage {
  requireVisible(db, id, actor);
  const body = redactSecrets(messageSchema.parse(raw));
  const provenance: AgentIdentityProvenance =
    actor === 'operator'
      ? 'VERIFIED'
      : listAgentDirectory(db).find((agent) => agent.label === actor)?.trustLevel === 'VERIFIED'
        ? 'VERIFIED'
        : 'ASSERTED';
  const message = {
    id: crypto.randomUUID(),
    conversationId: id,
    senderLabel: actor,
    sentAt: now.toISOString(),
    body,
    provenance,
  };
  db.prepare(
    'INSERT INTO agent_conversation_messages(id,conversation_id,sender_label,sent_at,body,sender_provenance) VALUES(?,?,?,?,?,?)',
  ).run(message.id, id, actor, message.sentAt, message.body, message.provenance);
  db.prepare('UPDATE agent_conversations SET updated_at=? WHERE id=?').run(message.sentAt, id);
  return message;
}
export function listMessages(
  db: Db,
  id: string,
  actor: string | null,
  raw: unknown = {},
): CursorPage<AgentConversationMessage> {
  requireVisible(db, id, actor);
  const input = raw as { limit?: number; cursor?: string; direction?: 'forward' | 'before' };
  const limit = Math.min(input.limit ?? 50, 100),
    c = decode(input.cursor);
  const before = input.direction === 'before';
  const statement = db.prepare(
    before
      ? `SELECT * FROM agent_conversation_messages WHERE conversation_id=? AND (? IS NULL OR sent_at<? OR (sent_at=? AND id<?)) ORDER BY sent_at DESC,id DESC LIMIT ?`
      : `SELECT * FROM agent_conversation_messages WHERE conversation_id=? AND (? IS NULL OR sent_at>? OR (sent_at=? AND id>?)) ORDER BY sent_at ASC,id ASC LIMIT ?`,
  );
  const rows = (
    before
      ? statement.all(id, c?.at ?? null, c?.at ?? '', c?.at ?? '', c?.id ?? '', limit + 1)
      : statement.all(id, c?.at ?? null, c?.at ?? '', c?.at ?? '', c?.id ?? '', limit + 1)
  ) as {
    id: string;
    conversation_id: string;
    sender_label: string;
    sent_at: string;
    body: string;
    sender_provenance: AgentIdentityProvenance;
  }[];
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    senderLabel: r.sender_label,
    sentAt: r.sent_at,
    body: r.body,
    provenance: r.sender_provenance,
  }));
  if (before) items.reverse();
  const last = before ? items[0] : items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encode(last.sentAt, last.id) : null,
    hasMore: rows.length > limit,
  };
}
export function setConversationState(
  db: Db,
  id: string,
  actor: string,
  state: ConversationState,
  now = new Date(),
) {
  requireVisible(db, id, actor);
  db.prepare('UPDATE agent_conversations SET state=?,updated_at=? WHERE id=?').run(
    state,
    now.toISOString(),
    id,
  );
  return getConversation(db, id, actor);
}
export function purgeArchivedConversations(db: Db, before: string) {
  return db
    .prepare("DELETE FROM agent_conversations WHERE state='ARCHIVED' AND updated_at < ?")
    .run(before).changes;
}

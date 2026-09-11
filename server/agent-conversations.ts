import crypto from 'node:crypto';
import type { Db } from './db.ts';
import { transaction } from './db.ts';
import { redactSecrets } from './integration-log.ts';
import { listAgentDirectory } from './agent-directory.ts';
import { insertHandoff } from './agent-coordination/service.ts';
import { knownAgentMentionLabels } from '../shared/agent-mentions.ts';
import type { AgentIdentityProvenance } from '../shared/agent-coordination.ts';
import {
  conversationDecisionSchema,
  createConversationSchema,
  postMessageInputSchema,
  type AgentConversation,
  type AgentConversationMessage,
  type ConversationState,
  type CreateConversationInput,
  type CursorPage,
  type MessageLinkedHandoff,
  type PostMessageInput,
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
  is_decision: number;
  decision_outcome: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
};
const toConversation = (row: ConversationRow, participants: string[]): AgentConversation => ({
  id: row.id,
  title: row.title,
  scope: { type: row.scope_type as AgentConversation['scope']['type'], id: row.scope_id },
  state: row.state,
  isDecision: row.is_decision === 1,
  decisionOutcome: row.decision_outcome,
  decidedAt: row.decided_at,
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

const registeredLabels = (db: Db) => listAgentDirectory(db).map((agent) => agent.label);

const linkedHandoffsForMessages = (
  db: Db,
  messageIds: readonly string[],
): Map<string, MessageLinkedHandoff[]> => {
  if (messageIds.length === 0) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT l.message_id, l.to_agent_label, h.id, h.state
       FROM agent_conversation_message_handoffs l
       JOIN agent_handoffs h ON h.id = l.handoff_id
       WHERE l.message_id IN (${placeholders})
       ORDER BY l.to_agent_label COLLATE NOCASE`,
    )
    .all(...messageIds) as {
    message_id: string;
    to_agent_label: string;
    id: string;
    state: MessageLinkedHandoff['state'];
  }[];
  const byMessage = new Map<string, MessageLinkedHandoff[]>();
  for (const row of rows) {
    const current = byMessage.get(row.message_id) ?? [];
    current.push({ id: row.id, toAgentLabel: row.to_agent_label, state: row.state });
    byMessage.set(row.message_id, current);
  }
  return byMessage;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_label: string;
  sent_at: string;
  body: string;
  sender_provenance: AgentIdentityProvenance;
  thought_summary?: string | null;
};

const toMessage = (row: MessageRow, linked: MessageLinkedHandoff[]): AgentConversationMessage => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderLabel: row.sender_label,
  sentAt: row.sent_at,
  body: row.body,
  thoughtSummary: row.thought_summary ?? null,
  provenance: row.sender_provenance,
  linkedHandoffs: linked,
});

const loadMessageById = (db: Db, messageId: string): AgentConversationMessage => {
  const row = db.prepare('SELECT * FROM agent_conversation_messages WHERE id=?').get(messageId) as
    | MessageRow
    | undefined;
  if (!row) throw Object.assign(new Error('Message not found.'), { status: 404 });
  const linked = linkedHandoffsForMessages(db, [row.id]).get(row.id) ?? [];
  return toMessage(row, linked);
};

const parsePostInput = (raw: unknown): PostMessageInput => {
  if (typeof raw === 'string') return postMessageInputSchema.parse({ body: raw });
  if (raw && typeof raw === 'object' && 'body' in raw) return postMessageInputSchema.parse(raw);
  return postMessageInputSchema.parse({ body: raw });
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
  const input = raw as {
    state?: ConversationState;
    isDecision?: boolean;
    scopeType?: string;
    scopeId?: string;
    limit?: number;
    cursor?: string;
  };
  const limit = Math.min(input.limit ?? 50, 100),
    c = decode(input.cursor);
  const where = ['1=1'];
  const params: string[] = [];
  if (input.scopeType && input.scopeId) {
    where.push('c.scope_type=? AND c.scope_id=?');
    params.push(input.scopeType, input.scopeId);
  }
  if (input.isDecision !== undefined) {
    where.push('c.is_decision=?');
    params.push(input.isDecision ? '1' : '0');
  }
  if (input.state) {
    where.push('c.state=?');
    params.push(input.state);
  }
  const rows = db
    .prepare(
      `SELECT c.*, COUNT(m.id) message_count FROM agent_conversations c JOIN agent_conversation_participants p ON p.conversation_id=c.id LEFT JOIN agent_conversation_messages m ON m.conversation_id=c.id WHERE ${where.join(' AND ')} GROUP BY c.id ORDER BY c.updated_at DESC,c.id DESC`,
    )
    .all(...params) as unknown as ConversationRow[];
  const visibleRows = rows.filter(
    (r) =>
      (actor === null || visible(db, r.id, actor)) &&
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
  const conversation = requireVisible(db, id, actor);
  const input = parsePostInput(raw);
  const body = redactSecrets(input.body);
  const instant = now.toISOString();
  const directory = registeredLabels(db);
  const offered = new Set(knownAgentMentionLabels(body, directory));
  for (const label of input.confirmHandoffs) {
    if (!offered.has(label)) {
      throw Object.assign(
        new Error(`Handoff confirmation for @${label} is not offered by this message.`),
        {
          status: 400,
        },
      );
    }
  }
  const confirmed = [...new Set(input.confirmHandoffs.filter((label) => offered.has(label)))];
  const provenance: AgentIdentityProvenance =
    actor === 'operator'
      ? 'VERIFIED'
      : listAgentDirectory(db).find((agent) => agent.label === actor)?.trustLevel === 'VERIFIED'
        ? 'VERIFIED'
        : 'ASSERTED';

  return transaction(db, () => {
    if (input.clientRequestId) {
      const replay = db
        .prepare(
          `SELECT message_id FROM agent_conversation_post_requests
           WHERE conversation_id=? AND client_request_id=?`,
        )
        .get(id, input.clientRequestId) as { message_id: string } | undefined;
      if (replay) return loadMessageById(db, replay.message_id);
    }

    const messageId = crypto.randomUUID();
    const thoughtSummary =
      actor === 'operator' ? null : (input.thoughtSummary?.trim() ?? null) || null;
    db.prepare(
      'INSERT INTO agent_conversation_messages(id,conversation_id,sender_label,sent_at,body,sender_provenance,thought_summary) VALUES(?,?,?,?,?,?,?)',
    ).run(messageId, id, actor, instant, body, provenance, thoughtSummary);
    if (input.clientRequestId) {
      db.prepare(
        'INSERT INTO agent_conversation_post_requests(conversation_id,client_request_id,message_id) VALUES(?,?,?)',
      ).run(id, input.clientRequestId, messageId);
    }

    const linked: MessageLinkedHandoff[] = [];
    const participantInsert = db.prepare(
      'INSERT OR IGNORE INTO agent_conversation_participants(conversation_id,agent_label) VALUES(?,?)',
    );
    const linkInsert = db.prepare(
      'INSERT INTO agent_conversation_message_handoffs(message_id,handoff_id,to_agent_label) VALUES(?,?,?)',
    );

    for (const label of confirmed) {
      participantInsert.run(id, label);
      const handoffRequestId = input.clientRequestId
        ? `${input.clientRequestId}:mention:${label}`
        : undefined;
      const handoff = insertHandoff(
        db,
        {
          fromAgentLabel: actor === 'operator' ? 'operator' : actor,
          fromAgentProvenance: provenance,
          toAgentLabel: label,
          subjectType: conversation.scope_type as 'client' | 'project' | 'task' | 'freeform',
          subjectId: conversation.scope_type === 'freeform' ? null : conversation.scope_id,
          message: body,
          clientRequestId: handoffRequestId,
        },
        instant,
      );
      linkInsert.run(messageId, handoff.id, label);
      linked.push({ id: handoff.id, toAgentLabel: label, state: handoff.state });
    }

    db.prepare('UPDATE agent_conversations SET updated_at=? WHERE id=?').run(instant, id);
    return toMessage(
      {
        id: messageId,
        conversation_id: id,
        sender_label: actor,
        sent_at: instant,
        body,
        sender_provenance: provenance,
        thought_summary: thoughtSummary,
      },
      linked,
    );
  });
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
  ) as MessageRow[];
  const linkedByMessage = linkedHandoffsForMessages(
    db,
    rows.slice(0, limit).map((row) => row.id),
  );
  const items = rows
    .slice(0, limit)
    .map((row) => toMessage(row, linkedByMessage.get(row.id) ?? []));
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

export function markConversationDecision(
  db: Db,
  id: string,
  actor: string,
  raw: unknown = {},
  now = new Date(),
) {
  const row = requireVisible(db, id, actor);
  const input = conversationDecisionSchema.parse(raw);
  const outcome = Object.hasOwn(input, 'outcome') ? input.outcome || null : row.decision_outcome;
  const at = now.toISOString();
  transaction(db, () => {
    db.prepare(
      `UPDATE agent_conversations
       SET is_decision=1, decision_outcome=?, decided_at=COALESCE(decided_at,?), updated_at=?
       WHERE id=?`,
    ).run(outcome, at, at, id);
  });
  return getConversation(db, id, actor);
}

export function clearConversationDecision(db: Db, id: string, actor: string, now = new Date()) {
  requireVisible(db, id, actor);
  transaction(db, () => {
    db.prepare(
      `UPDATE agent_conversations
       SET is_decision=0, decision_outcome=NULL, decided_at=NULL, updated_at=?
       WHERE id=?`,
    ).run(now.toISOString(), id);
  });
  return getConversation(db, id, actor);
}

export function purgeArchivedConversations(db: Db, before: string) {
  return db
    .prepare("DELETE FROM agent_conversations WHERE state='ARCHIVED' AND updated_at < ?")
    .run(before).changes;
}

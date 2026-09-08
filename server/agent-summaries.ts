import crypto from 'node:crypto';
import type { Db } from './db.ts';
import {
  presenceInputSchema,
  summaryListSchema,
  notificationListSchema,
  type AgentPresence,
  type AgentSummary,
  type AgentNotification,
} from '../shared/agent-summaries.ts';

const presence = (r: any): AgentPresence => ({
  agentLabel: r.agent_label,
  state: r.state,
  availability: r.availability,
  verifiedAt: r.verified_at,
  lastActivityAt: r.last_activity_at,
});
const notification = (r: any): AgentNotification => ({
  id: r.id,
  incidentKey: r.incident_key,
  kind: r.kind,
  agentLabel: r.agent_label,
  title: r.title,
  body: r.body,
  createdAt: r.created_at,
  readAt: r.read_at,
});
export function setPresence(db: Db, agentLabel: string, raw: unknown, now = new Date()) {
  const input = presenceInputSchema.parse(raw),
    at = now.toISOString();
  db.prepare(
    'INSERT INTO agent_presence(agent_label,state,availability,verified_at,last_activity_at) VALUES(?,?,?,?,?) ON CONFLICT(agent_label) DO UPDATE SET state=excluded.state,availability=excluded.availability,verified_at=excluded.verified_at,last_activity_at=excluded.last_activity_at',
  ).run(agentLabel, input.state, input.availability ?? null, at, at);
  return getPresence(db, agentLabel);
}
export function getPresence(db: Db, agentLabel: string) {
  const row = db.prepare('SELECT * FROM agent_presence WHERE agent_label=?').get(agentLabel);
  if (!row) throw Object.assign(new Error('Presence not found.'), { status: 404 });
  return presence(row);
}
export function listPresence(db: Db, raw: unknown = {}) {
  const q = summaryListSchema.parse(raw),
    rows = db
      .prepare(
        'SELECT * FROM agent_presence WHERE (? IS NULL OR agent_label=?) ORDER BY agent_label LIMIT ?',
      )
      .all(q.agentLabel ?? null, q.agentLabel ?? null, q.limit ?? 100);
  return { presence: (rows as any[]).map(presence) };
}
export function buildSummary(db: Db, agentLabel: string, now = new Date()): AgentSummary {
  const messages = db
    .prepare(
      'SELECT sender_label,body,sent_at,id FROM agent_conversation_messages WHERE sender_label=? ORDER BY sent_at DESC,id DESC LIMIT 5',
    )
    .all(agentLabel) as any[];
  const handoffs = db
    .prepare(
      'SELECT id,state,message,created_at FROM agent_handoffs WHERE from_agent_label=? OR to_agent_label=? ORDER BY created_at DESC,id DESC LIMIT 5',
    )
    .all(agentLabel, agentLabel) as any[];
  const evidence = [
    ...messages.map((x) => `conversation-message:${x.id}`),
    ...handoffs.map((x) => `handoff:${x.id}`),
  ].sort();
  const parts = [
    `${messages.length} recent message${messages.length === 1 ? '' : 's'}`,
    `${handoffs.length} recent handoff${handoffs.length === 1 ? '' : 's'}`,
  ];
  return {
    id: crypto
      .createHash('sha256')
      .update(`${agentLabel}|${evidence.join('|')}|${parts.join('|')}`)
      .digest('hex')
      .slice(0, 24),
    agentLabel,
    text: `${agentLabel}: ${parts.join('; ')}.`,
    generatedAt: now.toISOString(),
    evidence,
  };
}
export function listSummaries(db: Db, raw: unknown = {}, now = new Date()) {
  const q = summaryListSchema.parse(raw);
  const labels = q.agentLabel
    ? [q.agentLabel]
    : (
        db
          .prepare(
            'SELECT display_label label FROM agent_registrations ORDER BY display_label LIMIT ?',
          )
          .all(q.limit ?? 100) as any[]
      ).map((x) => x.label);
  return { summaries: labels.map((x) => buildSummary(db, x, now)) };
}
export function notify(
  db: Db,
  input: { incidentKey: string; kind: string; agentLabel: string; title: string; body: string },
  now = new Date(),
) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT OR IGNORE INTO agent_notifications(id,incident_key,kind,agent_label,title,body,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    id,
    input.incidentKey,
    input.kind,
    input.agentLabel,
    input.title,
    input.body,
    now.toISOString(),
  );
  return notification(
    db.prepare('SELECT * FROM agent_notifications WHERE incident_key=?').get(input.incidentKey),
  );
}
export function listNotifications(db: Db, raw: unknown = {}) {
  const q = notificationListSchema.parse(raw);
  const rows = db
    .prepare(
      'SELECT * FROM agent_notifications WHERE (?=0 OR read_at IS NULL) ORDER BY created_at DESC,id DESC LIMIT ?',
    )
    .all(q.unreadOnly ? 1 : 0, q.limit ?? 100);
  return { notifications: (rows as any[]).map(notification) };
}
export function markNotificationRead(db: Db, id: string, now = new Date()) {
  const result = db
    .prepare('UPDATE agent_notifications SET read_at=? WHERE id=? AND read_at IS NULL')
    .run(now.toISOString(), id);
  if (!result.changes) throw Object.assign(new Error('Notification not found.'), { status: 404 });
  return notification(db.prepare('SELECT * FROM agent_notifications WHERE id=?').get(id));
}

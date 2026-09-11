import crypto from 'node:crypto';
import { tipAgentHubNotifications } from './agent-hub/tips.ts';
import type { Db } from './db.ts';
import {
  presenceInputSchema,
  summaryListSchema,
  notificationListSchema,
  type AgentPresence,
  type AgentSummary,
  type AgentNotification,
  notificationInputSchema,
  type NotificationDestination,
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
  destination: r.destination_json ? JSON.parse(r.destination_json) : null,
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
export function notify(db: Db, input: unknown, now = new Date()) {
  const parsed = notificationInputSchema.parse(input);
  if (parsed.destination) validateDestination(db, parsed.destination);
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT OR IGNORE INTO agent_notifications(id,incident_key,kind,agent_label,title,body,destination_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    id,
    parsed.incidentKey,
    parsed.kind,
    parsed.agentLabel,
    parsed.title,
    parsed.body,
    parsed.destination ? JSON.stringify(parsed.destination) : null,
    now.toISOString(),
  );
  tipAgentHubNotifications();
  return notification(
    db.prepare('SELECT * FROM agent_notifications WHERE incident_key=?').get(parsed.incidentKey),
  );
}
export function listNotifications(db: Db, raw: unknown = {}) {
  const q = notificationListSchema.parse(raw);
  const cursor = decodeNotificationCursor(q.cursor);
  const where = ['(?=0 OR read_at IS NULL)'];
  const args: (string | number)[] = [q.unreadOnly ? 1 : 0];
  if (cursor) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    args.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .all(...args, (q.limit ?? 100) + 1) as any[];
  const page = rows.slice(0, q.limit ?? 100).map(notification);
  const last = page.at(-1);
  const unreadCount = (
    db.prepare('SELECT COUNT(*) count FROM agent_notifications WHERE read_at IS NULL').get() as any
  ).count;
  return {
    notifications: page,
    unreadCount,
    nextCursor:
      rows.length > (q.limit ?? 100) && last
        ? encodeNotificationCursor(last.createdAt, last.id)
        : null,
  };
}
const encodeNotificationCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
const decodeNotificationCursor = (cursor?: string): { at: string; id: string } | null => {
  if (!cursor) return null;
  try {
    const x = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof x.at !== 'string' || typeof x.id !== 'string') throw new Error();
    return x;
  } catch {
    throw new Error('Invalid notification cursor.');
  }
};
const validateDestination = (db: Db, destination: NotificationDestination) => {
  const exists =
    destination.type === 'agents'
      ? db.prepare('SELECT 1 FROM agent_registrations WHERE display_label=?').get(destination.id)
      : destination.type === 'conversation'
        ? db.prepare('SELECT 1 FROM agent_conversations WHERE id=?').get(destination.id)
        : destination.type === 'handoff'
          ? db.prepare('SELECT 1 FROM agent_handoffs WHERE id=?').get(destination.id)
          : db.prepare('SELECT 1 FROM agent_memory WHERE id=?').get(destination.id);
  if (!exists)
    throw Object.assign(new Error('Notification destination does not exist.'), { status: 404 });
};
export function markAllNotificationsRead(db: Db, now = new Date()) {
  const marked = (
    db
      .prepare('UPDATE agent_notifications SET read_at=? WHERE read_at IS NULL')
      .run(now.toISOString()) as any
  ).changes;
  if (marked > 0) tipAgentHubNotifications();
  return { marked };
}
export function markNotificationRead(db: Db, id: string, now = new Date()) {
  const result = db
    .prepare('UPDATE agent_notifications SET read_at=? WHERE id=? AND read_at IS NULL')
    .run(now.toISOString(), id);
  if (!result.changes) throw Object.assign(new Error('Notification not found.'), { status: 404 });
  tipAgentHubNotifications();
  return notification(db.prepare('SELECT * FROM agent_notifications WHERE id=?').get(id));
}

import crypto from 'node:crypto';
import type { Db } from './db.ts';
import {
  agentMemoryInputSchema,
  agentMemoryListSchema,
  agentMemoryPatchSchema,
  type AgentMemory,
  type AgentMemoryInput,
} from '../shared/agent-memory.ts';
const map = (r: any): AgentMemory => ({
  id: r.id,
  key: r.key,
  value: r.value,
  scope: { type: r.scope_type, id: r.scope_id },
  state: r.state,
  source: r.source,
  suggestedBy: r.suggested_by,
  approvedBy: r.approved_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
});
const ensureScope = (db: Db, scope: AgentMemoryInput['scope']) => {
  if (scope.type === 'workspace') return;
  const table = { client: 'clients', project: 'projects', task: 'tasks' }[scope.type];
  if (!(db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(scope.id ?? '') as unknown))
    throw Object.assign(new Error('The memory scope does not exist.'), { status: 404 });
};
export function suggestMemory(db: Db, raw: unknown, suggestedBy: string, now = new Date()) {
  const input = agentMemoryInputSchema.parse(raw);
  ensureScope(db, input.scope);
  const at = now.toISOString(),
    expires = new Date(now.getTime() + (input.retentionDays ?? 365) * 86400000).toISOString(),
    id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO agent_memory(id,key,value,scope_type,scope_id,state,source,suggested_by,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    input.key,
    input.value,
    input.scope.type,
    input.scope.id ?? null,
    'SUGGESTED',
    input.source,
    suggestedBy,
    at,
    at,
    expires,
  );
  return getMemory(db, id);
}
export function listMemory(db: Db, raw: unknown = {}) {
  const q = agentMemoryListSchema.parse(raw);
  purgeExpiredMemory(db);
  const clauses: string[] = [];
  const args: any[] = [];
  if (q.scope) {
    clauses.push('scope_type=?');
    args.push(q.scope);
  }
  if (q.scopeId) {
    clauses.push('scope_id=?');
    args.push(q.scopeId);
  }
  if (q.state) {
    clauses.push('state=?');
    args.push(q.state);
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_memory ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...args, q.limit ?? 50);
  return { memories: (rows as any[]).map(map) };
}
export function getMemory(db: Db, id: string) {
  const row = db.prepare('SELECT * FROM agent_memory WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('Memory record not found.'), { status: 404 });
  return map(row);
}
export function correctMemory(
  db: Db,
  id: string,
  raw: unknown,
  operator = 'operator',
  now = new Date(),
) {
  const patch = agentMemoryPatchSchema.parse(raw);
  const current = getMemory(db, id);
  const next = {
    key: patch.key ?? current.key,
    value: patch.value ?? current.value,
    scope: patch.scope ?? current.scope,
    retentionDays: patch.retentionDays,
  };
  ensureScope(db, next.scope);
  const at = now.toISOString(),
    expires = new Date(now.getTime() + (next.retentionDays ?? 365) * 86400000).toISOString();
  db.prepare(
    "UPDATE agent_memory SET key=?,value=?,scope_type=?,scope_id=?,state='APPROVED',approved_by=?,updated_at=?,expires_at=? WHERE id=?",
  ).run(next.key, next.value, next.scope.type, next.scope.id ?? null, operator, at, expires, id);
  return getMemory(db, id);
}
export function archiveMemory(db: Db, id: string, now = new Date()) {
  getMemory(db, id);
  db.prepare("UPDATE agent_memory SET state='ARCHIVED',updated_at=? WHERE id=?").run(
    now.toISOString(),
    id,
  );
  return getMemory(db, id);
}
export function deleteMemory(db: Db, id: string) {
  getMemory(db, id);
  db.prepare('DELETE FROM agent_memory WHERE id=?').run(id);
}
export function purgeExpiredMemory(db: Db, now = new Date()) {
  return db
    .prepare(
      "DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at < ? AND state != 'ARCHIVED'",
    )
    .run(now.toISOString()).changes;
}

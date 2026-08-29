import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { AgentWorkSessionError, canMutate } from '../domain/agent-work-sessions.ts';
import type { AgentWorkSession } from '../../shared/agent-work-sessions.ts';
const id = () => crypto.randomUUID();
type Row = Record<string, any>;
function out(r: Row): AgentWorkSession {
  return {
    id: r.id as string,
    handoffId: r.handoff_id as string,
    subjectType: r.subject_type as string,
    subjectId: r.subject_id as string | null,
    agentLabel: r.agent_label as string,
    state: r.state as AgentWorkSession['state'],
    leaseExpiresAt: r.lease_expires_at as string | null,
    lastHeartbeatAt: r.last_heartbeat_at as string | null,
    baseRevision: r.base_revision as string,
    branch: r.branch as string | null,
    worktree: r.worktree as string | null,
    currentStep: r.current_step as string | null,
    checkpoints: JSON.parse((r.checkpoints_json as string) || '[]'),
    evidence: JSON.parse((r.evidence_json as string) || '{}'),
    validations: JSON.parse((r.validations_json as string) || '[]'),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    abandonedAt: r.abandoned_at as string | null,
    abandonReason: r.abandon_reason as string | null,
  };
}
function get(db: Db, sid: string) {
  const r = db.prepare('SELECT * FROM agent_work_sessions WHERE id=?').get(sid) as Row | undefined;
  if (!r) throw new AgentWorkSessionError('Work session not found.', 404);
  return out(r);
}
export function startWorkSession(
  db: Db,
  input: {
    handoffId: string;
    agentLabel: string;
    leaseSeconds: number;
    baseRevision: string;
    branch?: string;
    worktree?: string;
    currentStep?: string;
  },
  now = new Date(),
): AgentWorkSession {
  return transaction(db, () => {
    const h = db.prepare('SELECT * FROM agent_handoffs WHERE id=?').get(input.handoffId) as
      Row | undefined;
    if (!h) throw new AgentWorkSessionError('Handoff not found.', 404);
    if (h.state !== 'CLAIMED' || h.claimed_by !== input.agentLabel)
      throw new AgentWorkSessionError(
        'The handoff must be CLAIMED by this agent before work can start.',
        409,
      );
    const live = db
      .prepare(
        "SELECT id FROM agent_work_sessions WHERE handoff_id=? AND state IN ('CLAIMED','IN_PROGRESS','NEEDS_INPUT','BLOCKED') AND lease_expires_at > ?",
      )
      .get(input.handoffId, now.toISOString());
    if (live)
      throw new AgentWorkSessionError('Another live work session already holds this handoff.', 409);
    const sid = id(),
      t = now.toISOString(),
      lease = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
    db.prepare(
      'INSERT INTO agent_work_sessions(id,handoff_id,subject_type,subject_id,agent_label,state,lease_expires_at,last_heartbeat_at,base_revision,branch,worktree,current_step,checkpoints_json,evidence_json,validations_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      sid,
      input.handoffId,
      h.subject_type,
      h.subject_id,
      input.agentLabel,
      'IN_PROGRESS',
      lease,
      t,
      input.baseRevision,
      input.branch ?? null,
      input.worktree ?? null,
      input.currentStep ?? null,
      '[]',
      '{}',
      '[]',
      t,
      t,
    );
    return get(db, sid);
  });
}
export function heartbeatWorkSession(
  db: Db,
  sid: string,
  agentLabel: string,
  leaseSeconds: number,
  now = new Date(),
) {
  return transaction(db, () => {
    const s = get(db, sid);
    canMutate(s, agentLabel, ['IN_PROGRESS', 'NEEDS_INPUT', 'BLOCKED']);
    const t = now.toISOString(),
      lease = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    db.prepare(
      'UPDATE agent_work_sessions SET lease_expires_at=?,last_heartbeat_at=?,updated_at=? WHERE id=?',
    ).run(lease, t, t, sid);
    return get(db, sid);
  });
}
export function checkpointWorkSession(
  db: Db,
  sid: string,
  agentLabel: string,
  input: { currentStep?: string; evidence?: Record<string, unknown>; validations?: unknown[] },
  now = new Date(),
) {
  return transaction(db, () => {
    const s = get(db, sid);
    canMutate(s, agentLabel, ['IN_PROGRESS', 'NEEDS_INPUT', 'BLOCKED']);
    const t = now.toISOString();
    const cps = [
      ...s.checkpoints,
      { at: t, step: input.currentStep ?? s.currentStep, evidence: input.evidence ?? s.evidence },
    ].slice(-50);
    db.prepare(
      'UPDATE agent_work_sessions SET current_step=?,checkpoints_json=?,evidence_json=?,validations_json=?,updated_at=? WHERE id=?',
    ).run(
      input.currentStep ?? s.currentStep,
      JSON.stringify(cps),
      JSON.stringify(input.evidence ?? s.evidence),
      JSON.stringify(input.validations ?? s.validations),
      t,
      sid,
    );
    return get(db, sid);
  });
}
export function transitionWorkSession(
  db: Db,
  sid: string,
  agentLabel: string,
  state: 'NEEDS_INPUT' | 'BLOCKED' | 'COMPLETED' | 'ABANDONED',
  reason: string | undefined,
  now = new Date(),
) {
  return transaction(db, () => {
    const s = get(db, sid);
    canMutate(
      s,
      agentLabel,
      state === 'COMPLETED'
        ? ['IN_PROGRESS', 'NEEDS_INPUT', 'BLOCKED']
        : ['IN_PROGRESS', 'NEEDS_INPUT', 'BLOCKED'],
    );
    const t = now.toISOString();
    db.prepare(
      'UPDATE agent_work_sessions SET state=?,abandoned_at=?,abandon_reason=?,updated_at=? WHERE id=?',
    ).run(state, state === 'ABANDONED' ? t : null, reason ?? null, t, sid);
    return get(db, sid);
  });
}
export function releaseWorkSession(
  db: Db,
  sid: string,
  agentLabel: string,
  reason: string,
  now = new Date(),
) {
  return transitionWorkSession(db, sid, agentLabel, 'ABANDONED', reason, now);
}
export function reclaimableWorkSessions(db: Db, now = new Date()): AgentWorkSession[] {
  return (
    db
      .prepare(
        "SELECT * FROM agent_work_sessions WHERE state IN ('CLAIMED','IN_PROGRESS','NEEDS_INPUT','BLOCKED') AND lease_expires_at <= ? ORDER BY updated_at ASC",
      )
      .all(now.toISOString()) as Row[]
  ).map(out);
}
export function reclaimWorkSession(
  db: Db,
  sid: string,
  reason = 'Lease expired; operator reclaimed work.',
  now = new Date(),
) {
  return transaction(db, () => {
    const s = get(db, sid);
    if (
      !['CLAIMED', 'IN_PROGRESS', 'NEEDS_INPUT', 'BLOCKED'].includes(s.state) ||
      !s.leaseExpiresAt ||
      Date.parse(s.leaseExpiresAt) > now.getTime()
    )
      throw new AgentWorkSessionError('Only an expired active session can be reclaimed.', 409);
    const t = now.toISOString();
    db.prepare(
      "UPDATE agent_work_sessions SET state='ABANDONED',abandoned_at=?,abandon_reason=?,updated_at=? WHERE id=?",
    ).run(t, reason, t, sid);
    db.prepare(
      "UPDATE agent_handoffs SET state='OPEN',claimed_by=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND state='CLAIMED'",
    ).run(t, s.handoffId);
    return get(db, sid);
  });
}
export function resumeWorkSession(db: Db, sid: string) {
  return get(db, sid);
}

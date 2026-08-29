/**
 * Deterministic non-production fixture for the MCP agent evaluation suite (C134 / #384).
 *
 * Never points at production. Seeds known clients, tasks, Signal drafts, and handoffs so every
 * scenario resolves the same subjects.
 */
import type { Db } from '../../db.ts';
import { postHandoff, claimHandoff } from '../../agent-coordination/service.ts';

export const EVAL_NOW = new Date('2026-08-29T16:00:00.000Z');
export const EVAL_STAMP = EVAL_NOW.toISOString();

export const EVAL_FIXTURE = {
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  targetTaskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  decoyTaskId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  openHandoffMessage: 'Evaluate: claim the caption review for Acme.',
  claimedHandoffMessage: 'Already claimed — agents must leave this alone.',
  targetTaskTitle: 'Draft launch caption for Acme',
  decoyTaskTitle: 'Unrelated archive sweep',
} as const;

export type EvalFixtureSeed = {
  openHandoffId: string;
  claimedHandoffId: string;
  targetTaskId: string;
  projectId: string;
  clientId: string;
};

export function seedEvalFixture(db: Db, now: Date = EVAL_NOW): EvalFixtureSeed {
  const stamp = now.toISOString();
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
  ).run(EVAL_FIXTURE.clientId, 'Acme Studio', 'acme-studio', stamp, stamp);
  db.prepare(
    `INSERT INTO projects(id,client_id,name,status,priority,position,drive_status,
       created_at,updated_at,last_activity_at)
     VALUES(?,?,?,'ACTIVE','MEDIUM',0,'DISCONNECTED',?,?,?)`,
  ).run(EVAL_FIXTURE.projectId, EVAL_FIXTURE.clientId, 'Launch Campaign', stamp, stamp, stamp);
  db.prepare(
    `INSERT INTO tasks(id,project_id,title,description,status,priority,due_date,position,
       created_at,updated_at)
     VALUES(?,?,?,?, 'TODO','HIGH',?,0,?,?)`,
  ).run(
    EVAL_FIXTURE.targetTaskId,
    EVAL_FIXTURE.projectId,
    EVAL_FIXTURE.targetTaskTitle,
    'Write the Instagram launch caption.',
    '2026-09-01',
    stamp,
    stamp,
  );
  db.prepare(
    `INSERT INTO tasks(id,project_id,title,description,status,priority,due_date,position,
       created_at,updated_at)
     VALUES(?,?,?,?, 'BACKLOG','LOW',NULL,1,?,?)`,
  ).run(
    EVAL_FIXTURE.decoyTaskId,
    EVAL_FIXTURE.projectId,
    EVAL_FIXTURE.decoyTaskTitle,
    'Noise for search.',
    stamp,
    stamp,
  );

  const open = postHandoff(
    db,
    {
      fromAgentLabel: 'planner',
      toAgentLabel: 'cursor-eval',
      subjectType: 'task',
      subjectId: EVAL_FIXTURE.targetTaskId,
      message: EVAL_FIXTURE.openHandoffMessage,
    },
    now,
  );
  const claimed = postHandoff(
    db,
    {
      fromAgentLabel: 'planner',
      toAgentLabel: null,
      subjectType: 'freeform',
      subjectId: null,
      message: EVAL_FIXTURE.claimedHandoffMessage,
    },
    now,
  );
  claimHandoff(db, claimed.id, 'codex-busy', now);

  return {
    openHandoffId: open.id,
    claimedHandoffId: claimed.id,
    targetTaskId: EVAL_FIXTURE.targetTaskId,
    projectId: EVAL_FIXTURE.projectId,
    clientId: EVAL_FIXTURE.clientId,
  };
}

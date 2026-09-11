/**
 * Agent handoff persistence (C110).
 *
 * Transactional writes for post, claim, complete, cancel, and notes. Domain authorization lives in
 * `server/domain/agent-coordination.ts`; this module is the only place that touches
 * `agent_handoffs` / `agent_handoff_notes`.
 *
 * No `integration_events` row — coordination is local metadata; the handoff row and notes are the
 * audit trail. Completing a handoff mutates neither workspace rows nor any provider path.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { redactSecrets } from '../integration-log.ts';
import {
  AgentCoordinationError,
  decideAddNote,
  decideAgentCancel,
  decideClaim,
  decideComplete,
  decideOperatorCancel,
} from '../domain/agent-coordination.ts';
import {
  agentHandoffCancelInputSchema,
  agentHandoffCompletionInputSchema,
  agentHandoffNoteInputSchema,
  agentHandoffPostInputSchema,
  agentHandoffListFilterSchema,
  AGENT_HANDOFF_LIST_DEFAULT_LIMIT,
  agentLabelSchema,
  type AgentHandoff,
  type AgentIdentityProvenance,
  type AgentHandoffCancelInput,
  type AgentHandoffDetail,
  type AgentHandoffCompletionInput,
  type AgentHandoffOutcome,
  type AgentHandoffNote,
  type AgentHandoffNoteInput,
  type AgentHandoffPage,
  type AgentHandoffPostInput,
  type AgentHandoffState,
  type AgentHandoffSubjectType,
} from '../../shared/agent-coordination.ts';
import {
  findHandoffMutation,
  recordHandoffMutation,
  type AgentHandoffMutationTool,
} from './mutations.ts';
import { recordChangeFeedEvent } from '../change-feeds.ts';
import { applyHandoffSources } from '../agent-conversation-handoffs.ts';

const id = () => crypto.randomUUID();

const recordCoordinationChange = (
  db: Db,
  kind: string,
  handoffId: string,
  summary: string,
  at: string,
) => {
  recordChangeFeedEvent(db, {
    feed: 'coordination',
    kind,
    entityType: 'handoff',
    entityId: handoffId,
    summary,
    at,
  });
};

interface HandoffRow {
  id: string;
  created_at: string;
  updated_at: string;
  from_agent_label: string;
  from_agent_provenance: string;
  to_agent_label: string | null;
  subject_type: string;
  subject_id: string | null;
  message: string;
  state: string;
  claimed_by: string | null;
  claimed_by_provenance: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  completed_by_provenance: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  client_request_id: string | null;
  outcome: string | null;
  result_summary: string | null;
  changed_paths_json: string | null;
  references_json: string | null;
  validations_json: string | null;
  remaining_risks_json: string | null;
}

const jsonArray = <T>(value: string | null): T[] => (value ? (JSON.parse(value) as T[]) : []);

interface NoteRow {
  id: string;
  handoff_id: string;
  agent_label: string;
  agent_provenance: string;
  body: string;
  at: string;
}

const toHandoff = (row: HandoffRow): AgentHandoff => ({
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  fromAgentLabel: row.from_agent_label,
  fromAgentProvenance: row.from_agent_provenance as AgentIdentityProvenance,
  toAgentLabel: row.to_agent_label,
  subjectType: row.subject_type as AgentHandoffSubjectType,
  subjectId: row.subject_id,
  message: row.message,
  state: row.state as AgentHandoffState,
  claimedBy: row.claimed_by,
  claimedByProvenance: row.claimed_by_provenance as AgentIdentityProvenance | null,
  claimedAt: row.claimed_at,
  completedAt: row.completed_at,
  completedByProvenance: row.completed_by_provenance as AgentIdentityProvenance | null,
  cancelledAt: row.cancelled_at,
  cancelReason: row.cancel_reason,
  clientRequestId: row.client_request_id,
  outcome: row.outcome as AgentHandoffOutcome | null,
  resultSummary: row.result_summary,
  changedPaths: jsonArray<string>(row.changed_paths_json),
  references: jsonArray<string>(row.references_json),
  validations: jsonArray<{ command: string; outcome: string }>(row.validations_json),
  remainingRisks: jsonArray<string>(row.remaining_risks_json),
});

const toNote = (row: NoteRow): AgentHandoffNote => ({
  id: row.id,
  handoffId: row.handoff_id,
  agentLabel: row.agent_label,
  agentProvenance: row.agent_provenance as AgentIdentityProvenance,
  body: row.body,
  at: row.at,
});

const selectHandoff = (db: Db, handoffId: string): AgentHandoff | null => {
  const row = db.prepare('SELECT * FROM agent_handoffs WHERE id = ?').get(handoffId) as
    HandoffRow | undefined;
  return row ? toHandoff(row) : null;
};

const requireHandoff = (db: Db, handoffId: string): AgentHandoff => {
  const handoff = selectHandoff(db, handoffId);
  if (!handoff) throw new AgentCoordinationError('Handoff not found.', 404);
  return handoff;
};

const notesFor = (db: Db, handoffId: string): AgentHandoffNote[] =>
  (
    db
      .prepare('SELECT * FROM agent_handoff_notes WHERE handoff_id = ? ORDER BY at ASC, id ASC')
      .all(handoffId) as unknown as NoteRow[]
  ).map(toNote);

const refuse = (reason: string): never => {
  throw new AgentCoordinationError(reason, 409);
};

export interface HandoffMutationOptions {
  clientRequestId?: string;
  mutationTool?: AgentHandoffMutationTool;
  agentIdentityProvenance?: AgentIdentityProvenance;
}

const replayHandoffOutcome = (
  db: Db,
  agentLabel: string,
  clientRequestId: string,
  tool: AgentHandoffMutationTool,
): AgentHandoff | null => {
  const stored = findHandoffMutation(db, agentLabel, clientRequestId, tool);
  if (!stored || stored.resultKind !== 'handoff') return null;
  return selectHandoff(db, stored.resultId);
};

const replayNoteOutcome = (
  db: Db,
  agentLabel: string,
  clientRequestId: string,
  tool: AgentHandoffMutationTool,
): AgentHandoffNote | null => {
  const stored = findHandoffMutation(db, agentLabel, clientRequestId, tool);
  if (!stored || stored.resultKind !== 'note') return null;
  const row = db
    .prepare('SELECT * FROM agent_handoff_notes WHERE id = ?')
    .get(stored.resultId) as unknown as NoteRow | undefined;
  return row ? toNote(row) : null;
};

export function getHandoff(db: Db, handoffId: string): AgentHandoffDetail {
  const handoff = requireHandoff(db, handoffId);
  const [withSource] = applyHandoffSources(db, [handoff]);
  return { ...withSource!, notes: notesFor(db, handoffId) };
}

export function listHandoffs(db: Db, rawFilter: unknown = {}): AgentHandoffPage {
  const filter = agentHandoffListFilterSchema.parse(rawFilter);
  const limit = filter.limit ?? AGENT_HANDOFF_LIST_DEFAULT_LIMIT;
  const offset = filter.offset ?? 0;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.state) {
    where.push('state = ?');
    params.push(filter.state);
  }
  if (filter.subjectType && filter.subjectId) {
    where.push('subject_type = ? AND subject_id = ?');
    params.push(filter.subjectType, filter.subjectId);
  }
  params.push(limit + 1, offset);
  const rows = db
    .prepare(
      `SELECT * FROM agent_handoffs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as unknown as HandoffRow[];
  return {
    handoffs: applyHandoffSources(db, rows.slice(0, limit).map(toHandoff)),
    limit,
    offset,
    truncated: rows.length > limit,
  };
}

export function countHandoffs(db: Db, state: AgentHandoffState): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM agent_handoffs WHERE state = ?')
    .get(state) as {
    count: number;
  };
  return row.count;
}

/**
 * Inserts an OPEN handoff when the caller already holds a database transaction.
 * Returns the existing row when `(from_agent_label, client_request_id)` already exists.
 */
export function insertHandoff(
  db: Db,
  raw: AgentHandoffPostInput,
  instant: string,
): AgentHandoff {
  const input = agentHandoffPostInputSchema.parse(raw);
  const message = redactSecrets(input.message);
  const toAgentLabel = input.toAgentLabel ?? null;
  const subjectId = input.subjectId ?? null;
  const clientRequestId = input.clientRequestId ?? null;

  if (clientRequestId) {
    const existing = db
      .prepare(
        `SELECT * FROM agent_handoffs
         WHERE from_agent_label = ? AND client_request_id = ?`,
      )
      .get(input.fromAgentLabel, clientRequestId) as HandoffRow | undefined;
    if (existing) return toHandoff(existing);
  }

  const handoffId = id();
  db.prepare(
    `INSERT INTO agent_handoffs(
       id, created_at, updated_at, from_agent_label, from_agent_provenance, to_agent_label,
       subject_type, subject_id, message, state,
       claimed_by, claimed_at, completed_at, cancelled_at, cancel_reason, client_request_id
     ) VALUES(?,?,?,?,?,?,?,?,?, 'OPEN', NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    handoffId,
    instant,
    instant,
    input.fromAgentLabel,
    input.fromAgentProvenance ?? 'UNKNOWN',
    toAgentLabel,
    input.subjectType,
    subjectId,
    message,
    clientRequestId,
  );
  recordCoordinationChange(db, 'handoff.posted', handoffId, 'Handoff posted.', instant);
  return requireHandoff(db, handoffId);
}

/**
 * Creates an OPEN handoff, or returns the existing row when `(from_agent_label, client_request_id)`
 * already exists. Never claims and never mutates workspace rows.
 */
export function postHandoff(
  db: Db,
  raw: AgentHandoffPostInput,
  now: Date = new Date(),
): AgentHandoff {
  const instant = now.toISOString();
  return transaction(db, () => insertHandoff(db, raw, instant));
}

/** Atomic claim: directed label match or open-pool first writer. */
export function claimHandoff(
  db: Db,
  handoffId: string,
  agentLabelRaw: string,
  now: Date = new Date(),
  agentIdentityProvenance: AgentIdentityProvenance = 'UNKNOWN',
): AgentHandoff {
  const agentLabel = agentLabelSchema.parse(agentLabelRaw);
  const instant = now.toISOString();
  return transaction(db, () => {
    const handoff = requireHandoff(db, handoffId);
    const decision = decideClaim(handoff, agentLabel);
    if (decision.kind === 'idempotent') return handoff;
    if (decision.kind === 'refused') refuse(decision.reason);
    db.prepare(
      `UPDATE agent_handoffs
       SET state = 'CLAIMED', claimed_by = ?, claimed_by_provenance = ?, claimed_at = ?, updated_at = ?
       WHERE id = ? AND state = 'OPEN'`,
    ).run(agentLabel, agentIdentityProvenance, instant, instant, handoffId);
    const next = requireHandoff(db, handoffId);
    if (next.state !== 'CLAIMED' || next.claimedBy !== agentLabel) {
      refuse('Another agent claimed this handoff first.');
    }
    recordCoordinationChange(db, 'handoff.claimed', handoffId, 'Handoff claimed.', instant);
    return next;
  });
}

export function completeHandoff(
  db: Db,
  handoffId: string,
  agentLabelRaw: string,
  raw: AgentHandoffCompletionInput,
  now: Date = new Date(),
  options: HandoffMutationOptions = {},
): AgentHandoff {
  const agentLabel = agentLabelSchema.parse(agentLabelRaw);
  const input = agentHandoffCompletionInputSchema.parse(raw);
  const evidence = {
    resultSummary: redactSecrets(input.resultSummary),
    changedPaths: (input.changedPaths ?? []).map(redactSecrets),
    references: (input.references ?? []).map(redactSecrets),
    validations: (input.validations ?? []).map((item) => ({
      command: redactSecrets(item.command),
      outcome: redactSecrets(item.outcome),
    })),
    remainingRisks: (input.remainingRisks ?? []).map(redactSecrets),
  };
  const clientRequestId = options.clientRequestId ?? null;
  const mutationTool = options.mutationTool ?? 'coordination_complete_handoff';
  const instant = now.toISOString();
  return transaction(db, () => {
    if (clientRequestId) {
      const replay = replayHandoffOutcome(db, agentLabel, clientRequestId, mutationTool);
      if (replay) return replay;
    }

    const handoff = requireHandoff(db, handoffId);
    const decision = decideComplete(handoff, agentLabel);
    if (decision.kind === 'idempotent') {
      if (clientRequestId) {
        recordHandoffMutation(db, {
          agentLabel,
          clientRequestId,
          tool: mutationTool,
          handoffId,
          resultKind: 'handoff',
          resultId: handoff.id,
          at: instant,
        });
      }
      return handoff;
    }
    if (decision.kind === 'refused') refuse(decision.reason);
    db.prepare(
      `UPDATE agent_handoffs
       SET state = 'COMPLETED', completed_at = ?, completed_by_provenance = ?, updated_at = ?, outcome = ?, result_summary = ?,
           changed_paths_json = ?, references_json = ?, validations_json = ?, remaining_risks_json = ?
       WHERE id = ? AND state = 'CLAIMED' AND claimed_by = ?`,
    ).run(
      instant,
      options.agentIdentityProvenance ?? 'UNKNOWN',
      instant,
      input.outcome,
      evidence.resultSummary,
      JSON.stringify(evidence.changedPaths),
      JSON.stringify(evidence.references),
      JSON.stringify(evidence.validations),
      JSON.stringify(evidence.remainingRisks),
      handoffId,
      agentLabel,
    );
    const next = requireHandoff(db, handoffId);
    if (next.state !== 'COMPLETED') refuse('The handoff could not be completed.');
    recordCoordinationChange(db, 'handoff.completed', handoffId, 'Handoff completed.', instant);
    if (clientRequestId) {
      recordHandoffMutation(db, {
        agentLabel,
        clientRequestId,
        tool: mutationTool,
        handoffId,
        resultKind: 'handoff',
        resultId: next.id,
        at: instant,
      });
    }
    return next;
  });
}

export function cancelHandoffAsAgent(
  db: Db,
  handoffId: string,
  agentLabelRaw: string,
  raw: AgentHandoffCancelInput,
  now: Date = new Date(),
  options: HandoffMutationOptions = {},
): AgentHandoff {
  const agentLabel = agentLabelSchema.parse(agentLabelRaw);
  const { reason } = agentHandoffCancelInputSchema.parse(raw);
  const cancelReason = redactSecrets(reason);
  const clientRequestId = options.clientRequestId ?? null;
  const mutationTool = options.mutationTool ?? 'coordination_cancel_handoff';
  const instant = now.toISOString();
  return transaction(db, () => {
    if (clientRequestId) {
      const replay = replayHandoffOutcome(db, agentLabel, clientRequestId, mutationTool);
      if (replay) return replay;
    }

    const handoff = requireHandoff(db, handoffId);
    const decision = decideAgentCancel(handoff, agentLabel);
    if (decision.kind === 'idempotent') {
      if (clientRequestId) {
        recordHandoffMutation(db, {
          agentLabel,
          clientRequestId,
          tool: mutationTool,
          handoffId,
          resultKind: 'handoff',
          resultId: handoff.id,
          at: instant,
        });
      }
      return handoff;
    }
    if (decision.kind === 'refused') refuse(decision.reason);
    db.prepare(
      `UPDATE agent_handoffs
       SET state = 'CANCELLED', cancelled_at = ?, cancel_reason = ?, updated_at = ?
       WHERE id = ? AND state IN ('OPEN', 'CLAIMED')`,
    ).run(instant, cancelReason, instant, handoffId);
    const next = requireHandoff(db, handoffId);
    if (next.state !== 'CANCELLED') refuse('The handoff could not be cancelled.');
    recordCoordinationChange(db, 'handoff.cancelled', handoffId, 'Handoff cancelled.', instant);
    if (clientRequestId) {
      recordHandoffMutation(db, {
        agentLabel,
        clientRequestId,
        tool: mutationTool,
        handoffId,
        resultKind: 'handoff',
        resultId: next.id,
        at: instant,
      });
    }
    return next;
  });
}

/** Operator HTTP cancel: any non-COMPLETED state. */
export function cancelHandoffAsOperator(
  db: Db,
  handoffId: string,
  raw: AgentHandoffCancelInput,
  now: Date = new Date(),
): AgentHandoff {
  const { reason } = agentHandoffCancelInputSchema.parse(raw);
  const cancelReason = redactSecrets(reason);
  const instant = now.toISOString();
  return transaction(db, () => {
    const handoff = requireHandoff(db, handoffId);
    const decision = decideOperatorCancel(handoff);
    if (decision.kind === 'idempotent') return handoff;
    if (decision.kind === 'refused') refuse(decision.reason);
    db.prepare(
      `UPDATE agent_handoffs
       SET state = 'CANCELLED', cancelled_at = ?, cancel_reason = ?, updated_at = ?
       WHERE id = ? AND state <> 'COMPLETED'`,
    ).run(instant, cancelReason, instant, handoffId);
    const next = requireHandoff(db, handoffId);
    if (next.state !== 'CANCELLED') refuse('The handoff could not be cancelled.');
    recordCoordinationChange(db, 'handoff.cancelled', handoffId, 'Handoff cancelled.', instant);
    return next;
  });
}

export function addHandoffNote(
  db: Db,
  handoffId: string,
  raw: AgentHandoffNoteInput,
  now: Date = new Date(),
  options: HandoffMutationOptions = {},
): AgentHandoffNote {
  const input = agentHandoffNoteInputSchema.parse(raw);
  const body = redactSecrets(input.body);
  const clientRequestId = options.clientRequestId ?? null;
  const mutationTool = options.mutationTool ?? 'coordination_add_note';
  const instant = now.toISOString();
  return transaction(db, () => {
    if (clientRequestId) {
      const replay = replayNoteOutcome(db, input.agentLabel, clientRequestId, mutationTool);
      if (replay) return replay;
    }

    const handoff = requireHandoff(db, handoffId);
    const decision = decideAddNote(handoff);
    if (decision.kind === 'refused') refuse(decision.reason);
    const noteId = id();
    db.prepare(
      `INSERT INTO agent_handoff_notes(id, handoff_id, agent_label, agent_provenance, body, at)
       VALUES(?,?,?,?,?,?)`,
    ).run(noteId, handoffId, input.agentLabel, input.agentProvenance ?? 'UNKNOWN', body, instant);
    // Touch updated_at so list views notice activity without changing handoff state.
    db.prepare('UPDATE agent_handoffs SET updated_at = ? WHERE id = ?').run(instant, handoffId);
    recordCoordinationChange(db, 'handoff.note_added', handoffId, 'Handoff note added.', instant);
    const row = db
      .prepare('SELECT * FROM agent_handoff_notes WHERE id = ?')
      .get(noteId) as unknown as NoteRow;
    const note = toNote(row);
    if (clientRequestId) {
      recordHandoffMutation(db, {
        agentLabel: input.agentLabel,
        clientRequestId,
        tool: mutationTool,
        handoffId,
        resultKind: 'note',
        resultId: note.id,
        at: instant,
      });
    }
    return note;
  });
}

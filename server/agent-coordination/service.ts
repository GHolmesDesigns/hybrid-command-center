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
  agentHandoffNoteInputSchema,
  agentHandoffPostInputSchema,
  agentLabelSchema,
  type AgentHandoff,
  type AgentHandoffCancelInput,
  type AgentHandoffDetail,
  type AgentHandoffNote,
  type AgentHandoffNoteInput,
  type AgentHandoffPostInput,
  type AgentHandoffState,
  type AgentHandoffSubjectType,
} from '../../shared/agent-coordination.ts';
import {
  findHandoffMutation,
  recordHandoffMutation,
  type AgentHandoffMutationTool,
} from './mutations.ts';

const id = () => crypto.randomUUID();

interface HandoffRow {
  id: string;
  created_at: string;
  updated_at: string;
  from_agent_label: string;
  to_agent_label: string | null;
  subject_type: string;
  subject_id: string | null;
  message: string;
  state: string;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  client_request_id: string | null;
}

interface NoteRow {
  id: string;
  handoff_id: string;
  agent_label: string;
  body: string;
  at: string;
}

const toHandoff = (row: HandoffRow): AgentHandoff => ({
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  fromAgentLabel: row.from_agent_label,
  toAgentLabel: row.to_agent_label,
  subjectType: row.subject_type as AgentHandoffSubjectType,
  subjectId: row.subject_id,
  message: row.message,
  state: row.state as AgentHandoffState,
  claimedBy: row.claimed_by,
  claimedAt: row.claimed_at,
  completedAt: row.completed_at,
  cancelledAt: row.cancelled_at,
  cancelReason: row.cancel_reason,
  clientRequestId: row.client_request_id,
});

const toNote = (row: NoteRow): AgentHandoffNote => ({
  id: row.id,
  handoffId: row.handoff_id,
  agentLabel: row.agent_label,
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
  return { ...handoff, notes: notesFor(db, handoffId) };
}

export function listHandoffs(db: Db, filter: { state?: AgentHandoffState } = {}): AgentHandoff[] {
  if (filter.state) {
    return (
      db
        .prepare(
          `SELECT * FROM agent_handoffs WHERE state = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(filter.state) as unknown as HandoffRow[]
    ).map(toHandoff);
  }
  return (
    db
      .prepare('SELECT * FROM agent_handoffs ORDER BY created_at DESC, id DESC')
      .all() as unknown as HandoffRow[]
  ).map(toHandoff);
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
  const input = agentHandoffPostInputSchema.parse(raw);
  const instant = now.toISOString();
  const message = redactSecrets(input.message);
  const toAgentLabel = input.toAgentLabel ?? null;
  const subjectId = input.subjectId ?? null;
  const clientRequestId = input.clientRequestId ?? null;

  return transaction(db, () => {
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
         id, created_at, updated_at, from_agent_label, to_agent_label,
         subject_type, subject_id, message, state,
         claimed_by, claimed_at, completed_at, cancelled_at, cancel_reason, client_request_id
       ) VALUES(?,?,?,?,?,?,?,?, 'OPEN', NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(
      handoffId,
      instant,
      instant,
      input.fromAgentLabel,
      toAgentLabel,
      input.subjectType,
      subjectId,
      message,
      clientRequestId,
    );
    return requireHandoff(db, handoffId);
  });
}

/** Atomic claim: directed label match or open-pool first writer. */
export function claimHandoff(
  db: Db,
  handoffId: string,
  agentLabelRaw: string,
  now: Date = new Date(),
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
       SET state = 'CLAIMED', claimed_by = ?, claimed_at = ?, updated_at = ?
       WHERE id = ? AND state = 'OPEN'`,
    ).run(agentLabel, instant, instant, handoffId);
    const next = requireHandoff(db, handoffId);
    if (next.state !== 'CLAIMED' || next.claimedBy !== agentLabel) {
      refuse('Another agent claimed this handoff first.');
    }
    return next;
  });
}

export function completeHandoff(
  db: Db,
  handoffId: string,
  agentLabelRaw: string,
  now: Date = new Date(),
  options: HandoffMutationOptions = {},
): AgentHandoff {
  const agentLabel = agentLabelSchema.parse(agentLabelRaw);
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
       SET state = 'COMPLETED', completed_at = ?, updated_at = ?
       WHERE id = ? AND state = 'CLAIMED' AND claimed_by = ?`,
    ).run(instant, instant, handoffId, agentLabel);
    const next = requireHandoff(db, handoffId);
    if (next.state !== 'COMPLETED') refuse('The handoff could not be completed.');
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
      `INSERT INTO agent_handoff_notes(id, handoff_id, agent_label, body, at)
       VALUES(?,?,?,?,?)`,
    ).run(noteId, handoffId, input.agentLabel, body, instant);
    // Touch updated_at so list views notice activity without changing handoff state.
    db.prepare('UPDATE agent_handoffs SET updated_at = ? WHERE id = ?').run(instant, handoffId);
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

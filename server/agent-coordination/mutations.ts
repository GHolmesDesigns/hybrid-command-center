/**
 * Idempotent MCP mutation keys for note, complete, and cancel (C117).
 *
 * Keys are `(agent_label, client_request_id, tool)` — the same id from another label is a distinct
 * request. Retention keeps the newest rows so replay keys cannot grow without bound.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import type { CoordinationWriteTool } from '../../shared/mcp-agent-events.ts';

/** Newest replay keys kept; same append-only discipline as `mcp_agent_events`. */
export const AGENT_HANDOFF_MUTATION_LIMIT = 500;

export const AGENT_HANDOFF_MUTATION_TOOLS = [
  'coordination_add_note',
  'coordination_complete_handoff',
  'coordination_cancel_handoff',
] as const;

export type AgentHandoffMutationTool = (typeof AGENT_HANDOFF_MUTATION_TOOLS)[number];

export type AgentHandoffMutationResultKind = 'note' | 'handoff';

export interface AgentHandoffMutationRecord {
  agentLabel: string;
  clientRequestId: string;
  tool: AgentHandoffMutationTool;
  handoffId: string;
  resultKind: AgentHandoffMutationResultKind;
  resultId: string;
}

interface MutationRow {
  agent_label: string;
  client_request_id: string;
  tool: string;
  handoff_id: string;
  result_kind: string;
  result_id: string;
}

const isMutationTool = (tool: CoordinationWriteTool): tool is AgentHandoffMutationTool =>
  (AGENT_HANDOFF_MUTATION_TOOLS as readonly string[]).includes(tool);

export function findHandoffMutation(
  db: Db,
  agentLabel: string,
  clientRequestId: string,
  tool: AgentHandoffMutationTool,
): AgentHandoffMutationRecord | null {
  const row = db
    .prepare(
      `SELECT agent_label, client_request_id, tool, handoff_id, result_kind, result_id
       FROM agent_handoff_mutations
       WHERE agent_label = ? AND client_request_id = ? AND tool = ?`,
    )
    .get(agentLabel, clientRequestId, tool) as MutationRow | undefined;
  if (!row) return null;
  return {
    agentLabel: row.agent_label,
    clientRequestId: row.client_request_id,
    tool: row.tool as AgentHandoffMutationTool,
    handoffId: row.handoff_id,
    resultKind: row.result_kind as AgentHandoffMutationResultKind,
    resultId: row.result_id,
  };
}

export function recordHandoffMutation(
  db: Db,
  input: AgentHandoffMutationRecord & { at?: string },
): void {
  const at = input.at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_handoff_mutations(
       id, created_at, agent_label, client_request_id, tool,
       handoff_id, result_kind, result_id
     ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    crypto.randomUUID(),
    at,
    input.agentLabel,
    input.clientRequestId,
    input.tool,
    input.handoffId,
    input.resultKind,
    input.resultId,
  );
  db.prepare(
    `DELETE FROM agent_handoff_mutations WHERE id NOT IN (
       SELECT id FROM agent_handoff_mutations ORDER BY created_at DESC, rowid DESC LIMIT ?
     )`,
  ).run(AGENT_HANDOFF_MUTATION_LIMIT);
}

export { isMutationTool };

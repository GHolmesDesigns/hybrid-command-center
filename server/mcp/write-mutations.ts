/**
 * Idempotent MCP local-write keys (C130).
 *
 * Keys are `(agent_label, client_request_id, tool)` — the same id from another label is a distinct
 * request. Retention keeps the newest rows so replay keys cannot grow without bound.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';

/** Newest replay keys kept; same append-only discipline as `mcp_agent_events`. */
export const MCP_WRITE_MUTATION_LIMIT = 500;

export interface McpWriteMutationRecord {
  agentLabel: string;
  clientRequestId: string;
  tool: string;
  entityType: string | null;
  entityId: string | null;
  result: unknown;
}

interface MutationRow {
  agent_label: string;
  client_request_id: string;
  tool: string;
  entity_type: string | null;
  entity_id: string | null;
  result_json: string;
}

export function findWriteMutation(
  db: Db,
  agentLabel: string,
  clientRequestId: string,
  tool: string,
): McpWriteMutationRecord | null {
  const row = db
    .prepare(
      `SELECT agent_label, client_request_id, tool, entity_type, entity_id, result_json
       FROM mcp_write_mutations
       WHERE agent_label = ? AND client_request_id = ? AND tool = ?`,
    )
    .get(agentLabel, clientRequestId, tool) as MutationRow | undefined;
  if (!row) return null;
  return {
    agentLabel: row.agent_label,
    clientRequestId: row.client_request_id,
    tool: row.tool,
    entityType: row.entity_type,
    entityId: row.entity_id,
    result: JSON.parse(row.result_json) as unknown,
  };
}

export function recordWriteMutation(db: Db, input: McpWriteMutationRecord & { at?: string }): void {
  const at = input.at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO mcp_write_mutations(
       id, created_at, agent_label, client_request_id, tool,
       entity_type, entity_id, result_json
     ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    crypto.randomUUID(),
    at,
    input.agentLabel,
    input.clientRequestId,
    input.tool,
    input.entityType,
    input.entityId,
    JSON.stringify(input.result),
  );
  db.prepare(
    `DELETE FROM mcp_write_mutations WHERE id NOT IN (
       SELECT id FROM mcp_write_mutations ORDER BY created_at DESC, rowid DESC LIMIT ?
     )`,
  ).run(MCP_WRITE_MUTATION_LIMIT);
}

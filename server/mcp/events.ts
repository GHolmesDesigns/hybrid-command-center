/**
 * Append-only MCP agent audit (`mcp_agent_events`).
 *
 * One INSERT and one retention DELETE — nothing updates a row. Free-text `summary` is scrubbed
 * with `redactSecrets` so tool refusals never park credentials in the audit trail.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { redactSecrets } from '../integration-log.ts';
import {
  MCP_AGENT_EVENT_LIMIT,
  type McpAgentEvent,
  type McpAgentEventOutcome,
} from '../../shared/mcp-agent-events.ts';

export interface McpAgentEventInput {
  agentLabel: string | null;
  tool: string;
  outcome: McpAgentEventOutcome;
  summary: string;
  entityType?: string | null;
  entityId?: string | null;
  at?: string;
}

interface EventRow {
  id: string;
  at: string;
  agent_label: string | null;
  tool: string;
  outcome: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
}

const NEWEST_FIRST = 'ORDER BY at DESC, rowid DESC';

export function recordMcpAgentEvent(db: Db, input: McpAgentEventInput): McpAgentEvent {
  const event: McpAgentEvent = {
    id: crypto.randomUUID(),
    at: input.at ?? new Date().toISOString(),
    agentLabel: input.agentLabel,
    tool: input.tool,
    outcome: input.outcome,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: redactSecrets(input.summary),
  };
  db.prepare(
    `INSERT INTO mcp_agent_events(id, at, agent_label, tool, outcome, entity_type, entity_id, summary)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    event.id,
    event.at,
    event.agentLabel,
    event.tool,
    event.outcome,
    event.entityType,
    event.entityId,
    event.summary,
  );
  db.prepare(
    `DELETE FROM mcp_agent_events WHERE id NOT IN (
       SELECT id FROM mcp_agent_events ${NEWEST_FIRST} LIMIT ?
     )`,
  ).run(MCP_AGENT_EVENT_LIMIT);
  return event;
}

export function listMcpAgentEvents(
  db: Db,
  options: { tool?: string; limit?: number } = {},
): McpAgentEvent[] {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (options.tool) {
    where.push('tool = ?');
    values.push(options.tool);
  }
  values.push(Math.min(options.limit ?? MCP_AGENT_EVENT_LIMIT, MCP_AGENT_EVENT_LIMIT));
  return (
    db
      .prepare(
        `SELECT * FROM mcp_agent_events
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ${NEWEST_FIRST} LIMIT ?`,
      )
      .all(...values) as unknown as EventRow[]
  ).map(toEvent);
}

function toEvent(row: EventRow): McpAgentEvent {
  return {
    id: row.id,
    at: row.at,
    agentLabel: row.agent_label,
    tool: row.tool,
    outcome: row.outcome as McpAgentEvent['outcome'],
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
  };
}

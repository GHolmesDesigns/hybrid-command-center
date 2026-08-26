/**
 * MCP agent audit vocabulary (MCP-C106 contract; first used by C111 coordination tools).
 *
 * Append-only rows for local MCP mutation tool calls. Retention and the sole INSERT live in
 * `server/mcp/events.ts`. Coordination writes also share the rolling rate-limit constant here so
 * the MCP layer and tests cannot diverge from `docs/agent-coordination-plan.md` §5.6.
 */
import { z } from 'zod';
import { agentLabelSchema } from './agent-coordination.ts';

export const MCP_AGENT_EVENT_OUTCOMES = ['SUCCESS', 'REFUSED', 'FAILURE'] as const;
export type McpAgentEventOutcome = (typeof MCP_AGENT_EVENT_OUTCOMES)[number];

/** Newest rows kept; same append-only discipline as `integration_events`, higher bound per C105. */
export const MCP_AGENT_EVENT_LIMIT = 500;

/** Coordination post/claim/complete/cancel/note combined, per MCP session. */
export const COORDINATION_WRITE_LIMIT_PER_MINUTE = 10;

export const COORDINATION_WRITE_TOOLS = [
  'coordination_post_handoff',
  'coordination_claim_handoff',
  'coordination_complete_handoff',
  'coordination_cancel_handoff',
  'coordination_add_note',
] as const;
export type CoordinationWriteTool = (typeof COORDINATION_WRITE_TOOLS)[number];

export const COORDINATION_READ_TOOLS = [
  'coordination_list_handoffs',
  'coordination_get_handoff',
] as const;
export type CoordinationReadTool = (typeof COORDINATION_READ_TOOLS)[number];

export const COORDINATION_TOOLS = [
  ...COORDINATION_READ_TOOLS,
  ...COORDINATION_WRITE_TOOLS,
] as const;
export type CoordinationTool = (typeof COORDINATION_TOOLS)[number];

export const COORDINATION_INBOX_URI = 'hcc://coordination/inbox?state=open';

export const mcpAgentEventOutcomeSchema = z.enum(MCP_AGENT_EVENT_OUTCOMES);

export interface McpAgentEvent {
  id: string;
  at: string;
  agentLabel: string | null;
  tool: string;
  outcome: McpAgentEventOutcome;
  entityType: string | null;
  entityId: string | null;
  summary: string;
}

/** Optional agent label from MCP init / env — empty becomes null (reads still work). */
export function normalizeOptionalAgentLabel(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return agentLabelSchema.parse(trimmed);
}

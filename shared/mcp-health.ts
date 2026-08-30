/**
 * MCP connection diagnostics and operator health panel vocabulary (C124).
 */
import { z } from 'zod';
import type { AgentHandoff } from './agent-coordination.ts';
import { AGENT_HANDOFF_OPEN_TTL_DAYS } from './agent-coordination.ts';
import type { McpAgentCredentialSummary } from './mcp-agent-registry.ts';
import {
  MCP_COORDINATION_ERROR_CODES,
  type McpCoordinationErrorCode,
} from './mcp-coordination-errors.ts';
import type { McpAgentEventOutcome } from './mcp-agent-events.ts';

export const MCP_HEALTH_PANEL_STATES = [
  'never_connected',
  'all_failed',
  'mixed',
  'healthy',
  'unavailable',
] as const;
export type McpHealthPanelState = (typeof MCP_HEALTH_PANEL_STATES)[number];

export const mcpConnectionCheckSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const mcpConnectionStatusSchema = z.object({
  ok: z.boolean(),
  transport: z.enum(['stdio', 'http', 'operator']),
  authenticated: z.boolean(),
  protocolVersion: z.string(),
  agentLabel: z.string().nullable(),
  grantedScopes: z.array(z.string()),
  // Identifies the SQLite file answering this connection (#410). Two connections with the same
  // agent label and tool list can still be talking to two independent stores — stdio against a
  // workstation checkout, HTTPS against the hosted origin — and this is what tells them apart.
  storeId: z.string(),
  serverVersion: z.string(),
  capabilityVersion: z.string(),
  serverClock: z.string(),
  checks: z.object({
    toolsList: mcpConnectionCheckSchema.extend({ toolCount: z.number().optional() }),
    resourcesList: mcpConnectionCheckSchema.extend({ resourceCount: z.number().optional() }),
    resourceRead: mcpConnectionCheckSchema.extend({
      uri: z.string().optional(),
      byteLength: z.number().optional(),
    }),
  }),
  testedAt: z.string(),
});

export type McpConnectionStatus = z.infer<typeof mcpConnectionStatusSchema>;

export const mcpHealthAgentStatsSchema = z.object({
  label: z.string(),
  lastUsedAt: z.string().nullable(),
  lastOrigin: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  requestCount: z.number(),
  refusalCount: z.number(),
  failureCount: z.number(),
  rateLimitCount: z.number(),
});

export type McpHealthAgentStats = z.infer<typeof mcpHealthAgentStatsSchema>;

export const mcpHealthErrorSummarySchema = z.object({
  code: z.enum(MCP_COORDINATION_ERROR_CODES),
  count: z.number(),
});

export type McpHealthErrorSummary = z.infer<typeof mcpHealthErrorSummarySchema>;

export const mcpHealthStaleHandoffSchema = z.object({
  id: z.string(),
  state: z.enum(['OPEN', 'CLAIMED']),
  subjectType: z.string(),
  subjectId: z.string().nullable(),
  fromAgentLabel: z.string(),
  staleSince: z.string(),
  reason: z.enum(['open_ttl', 'claimed_age']),
});

export type McpHealthStaleHandoff = z.infer<typeof mcpHealthStaleHandoffSchema>;

export const mcpHealthCompletionSchema = z.object({
  id: z.string(),
  outcome: z.enum(['SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'BLOCKED', 'SUPERSEDED']).nullable(),
  resultSummary: z.string().nullable(),
  completedAt: z.string(),
});

export const mcpHealthPanelSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(MCP_HEALTH_PANEL_STATES),
  stateReason: z.string().nullable(),
  generatedAt: z.string(),
  agents: z.array(mcpHealthAgentStatsSchema),
  errorSummary: z.array(mcpHealthErrorSummarySchema),
  staleHandoffs: z.array(mcpHealthStaleHandoffSchema),
  recentCompletions: z.array(mcpHealthCompletionSchema),
  auditEventCount: z.number(),
});

export type McpHealthPanel = z.infer<typeof mcpHealthPanelSchema>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (earlierIso: string, now: Date): number => {
  const earlier = Date.parse(earlierIso);
  if (Number.isNaN(earlier)) return 0;
  return (now.getTime() - earlier) / MS_PER_DAY;
};

/** CLAIMED handoffs older than the §5.4 OPEN TTL are stuck-work signals for the health panel. */
export function isStaleClaimedHandoff(handoff: AgentHandoff, now: Date = new Date()): boolean {
  return (
    handoff.state === 'CLAIMED' &&
    Boolean(handoff.claimedAt) &&
    daysBetween(handoff.claimedAt!, now) > AGENT_HANDOFF_OPEN_TTL_DAYS
  );
}

/** Map audit prose to the nearest structured code when the row predates structured storage. */
export function inferErrorCodeFromSummary(summary: string): McpCoordinationErrorCode | null {
  const lower = summary.toLowerCase();
  if (lower.includes('rate limit')) return 'COORDINATION_RATE_LIMIT_EXCEEDED';
  if (lower.includes('credential lacks workspace:')) return 'WORKSPACE_SCOPE_REQUIRED';
  if (lower.includes('credential lacks')) return 'COORDINATION_SCOPE_REQUIRED';
  if (lower.includes('x-agent-label') || lower.includes('label mismatch')) {
    return 'COORDINATION_CREDENTIAL_LABEL_MISMATCH';
  }
  if (lower.includes('session label')) return 'COORDINATION_SESSION_LABEL_MISMATCH';
  if (lower.includes('agent_label') || lower.includes('agent label')) {
    return 'COORDINATION_AGENT_LABEL_REQUIRED';
  }
  if (lower.includes('invalid state')) return 'COORDINATION_INVALID_STATE';
  if (lower.includes('not found')) return 'COORDINATION_NOT_FOUND';
  if (lower.includes('unknown tool')) return 'COORDINATION_UNKNOWN_TOOL';
  if (lower.includes('unauthorized')) return 'COORDINATION_UNAUTHORIZED';
  if (lower.includes('invalid argument')) return 'COORDINATION_INVALID_ARGUMENTS';
  return null;
}

export function isRateLimitSummary(summary: string): boolean {
  return summary.toLowerCase().includes('rate limit');
}

export function deriveMcpHealthPanelState(input: {
  registry: readonly McpAgentCredentialSummary[];
  agents: readonly McpHealthAgentStats[];
  auditUnreadable: boolean;
}): { state: McpHealthPanelState; reason: string | null } {
  if (input.auditUnreadable) {
    return { state: 'unavailable', reason: 'The MCP audit table could not be read.' };
  }
  const everConnected =
    input.registry.some((row) => row.lastUsedAt !== null) ||
    input.agents.some((row) => row.requestCount > 0);
  if (!everConnected) {
    return { state: 'never_connected', reason: null };
  }
  const withActivity = input.agents.filter((row) => row.requestCount > 0);
  if (withActivity.length && withActivity.every((row) => row.lastSuccessAt === null)) {
    return {
      state: 'all_failed',
      reason: 'Agents have connected, but every audited call failed or was refused.',
    };
  }
  if (
    withActivity.some((row) => row.lastSuccessAt && row.lastFailureAt) ||
    withActivity.some((row) => row.lastSuccessAt === null && row.requestCount > 0)
  ) {
    return { state: 'mixed', reason: null };
  }
  return { state: 'healthy', reason: null };
}

export function outcomeIsFailure(outcome: McpAgentEventOutcome): boolean {
  return outcome === 'FAILURE' || outcome === 'REFUSED';
}

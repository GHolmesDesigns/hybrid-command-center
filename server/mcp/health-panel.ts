/**
 * Operator MCP health panel aggregation (C124).
 *
 * Joins the C118 registry with append-only `mcp_agent_events` and stale handoff rules.
 */
import type { Db } from '../db.ts';
import { listMcpAgentCredentials } from '../auth/mcp-agent-credentials.ts';
import { listHandoffs } from '../agent-coordination/service.ts';
import {
  deriveMcpHealthPanelState,
  inferErrorCodeFromSummary,
  isRateLimitSummary,
  isStaleClaimedHandoff,
  outcomeIsFailure,
  type McpHealthAgentStats,
  type McpHealthErrorSummary,
  type McpHealthPanel,
  type McpHealthStaleHandoff,
} from '../../shared/mcp-health.ts';
import { isStaleOpenHandoff } from '../../shared/agent-coordination.ts';
import { MCP_AGENT_EVENT_LIMIT } from '../../shared/mcp-agent-events.ts';
import { listMcpAgentEvents } from './events.ts';

type EventRow = {
  agentLabel: string | null;
  at: string;
  outcome: string;
  summary: string;
};

export function buildMcpHealthPanel(
  db: Db,
  options: { enabled: boolean; now?: Date } = { enabled: true },
): McpHealthPanel {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();

  let auditUnreadable = false;
  let events: EventRow[] = [];
  try {
    events = listMcpAgentEvents(db, { limit: MCP_AGENT_EVENT_LIMIT }).map((event) => ({
      agentLabel: event.agentLabel,
      at: event.at,
      outcome: event.outcome,
      summary: event.summary,
    }));
  } catch {
    auditUnreadable = true;
  }

  const registry = options.enabled ? listMcpAgentCredentials(db, now.getTime()) : [];
  const agents = aggregateAgentStats(registry, events);
  const errorSummary = aggregateErrorSummary(events);
  const staleHandoffs = gatherStaleHandoffs(db, now);
  const { state, reason } = deriveMcpHealthPanelState({
    registry,
    agents,
    auditUnreadable,
  });

  return {
    enabled: options.enabled,
    state,
    stateReason: reason,
    generatedAt,
    agents,
    errorSummary,
    staleHandoffs,
    auditEventCount: events.length,
  };
}

function aggregateAgentStats(
  registry: ReturnType<typeof listMcpAgentCredentials>,
  events: EventRow[],
): McpHealthAgentStats[] {
  const byLabel = new Map<string, McpHealthAgentStats>();

  for (const credential of registry) {
    byLabel.set(credential.label.toLowerCase(), {
      label: credential.label,
      lastUsedAt: credential.lastUsedAt,
      lastOrigin: credential.lastOrigin,
      lastSuccessAt: null,
      lastFailureAt: null,
      requestCount: 0,
      refusalCount: 0,
      failureCount: 0,
      rateLimitCount: 0,
    });
  }

  for (const event of events) {
    if (!event.agentLabel) continue;
    const key = event.agentLabel.toLowerCase();
    const current = byLabel.get(key) ?? {
      label: event.agentLabel,
      lastUsedAt: null,
      lastOrigin: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      requestCount: 0,
      refusalCount: 0,
      failureCount: 0,
      rateLimitCount: 0,
    };
    current.requestCount += 1;
    if (event.outcome === 'REFUSED') current.refusalCount += 1;
    if (event.outcome === 'FAILURE') current.failureCount += 1;
    if (isRateLimitSummary(event.summary)) current.rateLimitCount += 1;
    if (event.outcome === 'SUCCESS') {
      if (!current.lastSuccessAt || event.at > current.lastSuccessAt) {
        current.lastSuccessAt = event.at;
      }
    } else if (outcomeIsFailure(event.outcome as 'REFUSED' | 'FAILURE' | 'SUCCESS')) {
      if (!current.lastFailureAt || event.at > current.lastFailureAt) {
        current.lastFailureAt = event.at;
      }
    }
    byLabel.set(key, current);
  }

  return [...byLabel.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function aggregateErrorSummary(events: EventRow[]): McpHealthErrorSummary[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.outcome === 'SUCCESS') continue;
    const code = inferErrorCodeFromSummary(event.summary);
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code: code as McpHealthErrorSummary['code'], count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function gatherStaleHandoffs(db: Db, now: Date): McpHealthStaleHandoff[] {
  const open = listHandoffs(db, { state: 'OPEN' });
  const claimed = listHandoffs(db, { state: 'CLAIMED' });
  const stale: McpHealthStaleHandoff[] = [];
  for (const handoff of open) {
    if (!isStaleOpenHandoff(handoff, now)) continue;
    stale.push({
      id: handoff.id,
      state: 'OPEN',
      subjectType: handoff.subjectType,
      subjectId: handoff.subjectId,
      fromAgentLabel: handoff.fromAgentLabel,
      staleSince: handoff.createdAt,
      reason: 'open_ttl',
    });
  }
  for (const handoff of claimed) {
    if (!isStaleClaimedHandoff(handoff, now)) continue;
    stale.push({
      id: handoff.id,
      state: 'CLAIMED',
      subjectType: handoff.subjectType,
      subjectId: handoff.subjectId,
      fromAgentLabel: handoff.fromAgentLabel,
      staleSince: handoff.claimedAt ?? handoff.createdAt,
      reason: 'claimed_age',
    });
  }
  return stale.sort((left, right) => right.staleSince.localeCompare(left.staleSince));
}

/**
 * Per-process MCP session state for coordination tools (C111).
 *
 * `agentLabel` is the sole agent principal for coordination writes (C105 §4.1 / C109 §5.1).
 * Reads work with a null label; writes refuse until a non-empty label is supplied at init.
 *
 * C133 adds cooperative cancellation and resource subscriptions on the same session object so
 * stdio and streamable HTTP share one protocol surface.
 */
import {
  COORDINATION_WRITE_LIMIT_PER_MINUTE,
  INTEGRATION_WRITE_LIMIT_PER_MINUTE,
  normalizeOptionalAgentLabel,
} from '../../shared/mcp-agent-events.ts';
import { RollingWindowLimiter, type CoordinationWriteLimiter } from './rate-limit.ts';
import type { AgentIdentityProvenance } from '../../shared/agent-coordination.ts';

const ONE_MINUTE_MS = 60_000;

export interface McpInFlightRequest {
  abort: AbortController;
}

export interface McpSession {
  agentLabel: string | null;
  /** Whether the transport cryptographically bound this label to a scoped credential. */
  agentIdentityProvenance: AgentIdentityProvenance;
  /**
   * Defaults to a fresh per-session `RollingWindowLimiter`, which is what stdio uses for the
   * life of its one long-lived process session. The network HTTP transport overwrites this per
   * request with a limiter drawn from the process-lifetime `McpWriteLimiterRegistry` (C116 /
   * `server/mcp/write-limiter-registry.ts`), since a fresh `McpSession` per POST would otherwise
   * make the budget a no-op.
   */
  coordinationWrites: CoordinationWriteLimiter;
  /**
   * Separate budget for Class-I integration writes (C131). Same HTTP registry pattern as
   * `coordinationWrites`, with `INTEGRATION_WRITE_LIMIT_PER_MINUTE` instead of 10.
   */
  integrationWrites: CoordinationWriteLimiter;
  /** Canonical resource URIs this session has subscribed to (`resources/subscribe`). */
  subscriptions: Set<string>;
  /** In-flight JSON-RPC request ids awaiting completion or `notifications/cancelled`. */
  inFlight: Map<string | number, McpInFlightRequest>;
}

export function createMcpSession(
  options: {
    agentLabel?: string | null;
    agentIdentityProvenance?: AgentIdentityProvenance;
  } = {},
): McpSession {
  return {
    agentLabel: normalizeOptionalAgentLabel(options.agentLabel ?? null),
    agentIdentityProvenance: options.agentIdentityProvenance ?? 'ASSERTED',
    coordinationWrites: new RollingWindowLimiter(
      COORDINATION_WRITE_LIMIT_PER_MINUTE,
      ONE_MINUTE_MS,
    ),
    integrationWrites: new RollingWindowLimiter(INTEGRATION_WRITE_LIMIT_PER_MINUTE, ONE_MINUTE_MS),
    subscriptions: new Set(),
    inFlight: new Map(),
  };
}

/** Apply a label discovered during MCP `initialize` (or from `MCP_AGENT_LABEL`). */
export function setMcpSessionAgentLabel(session: McpSession, raw: string | null | undefined): void {
  session.agentLabel = normalizeOptionalAgentLabel(raw);
}

export function setMcpSessionIdentityProvenance(
  session: McpSession,
  provenance: AgentIdentityProvenance,
): void {
  session.agentIdentityProvenance = provenance;
}

export function registerMcpInFlight(
  session: McpSession,
  requestId: string | number,
): AbortController {
  const existing = session.inFlight.get(requestId);
  if (existing) return existing.abort;
  const abort = new AbortController();
  session.inFlight.set(requestId, { abort });
  return abort;
}

export function clearMcpInFlight(session: McpSession, requestId: string | number): void {
  session.inFlight.delete(requestId);
}

/** Mark an in-flight request cancelled. Unknown ids are ignored (MCP cancellation races). */
export function cancelMcpInFlight(
  session: McpSession,
  requestId: string | number,
  reason?: string,
): boolean {
  const entry = session.inFlight.get(requestId);
  if (!entry) return false;
  entry.abort.abort(reason ?? 'cancelled');
  return true;
}

export function mcpRequestCancelled(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}

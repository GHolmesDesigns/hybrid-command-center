/**
 * Per-process MCP session state for coordination tools (C111).
 *
 * `agentLabel` is the sole agent principal for coordination writes (C105 §4.1 / C109 §5.1).
 * Reads work with a null label; writes refuse until a non-empty label is supplied at init.
 */
import {
  COORDINATION_WRITE_LIMIT_PER_MINUTE,
  normalizeOptionalAgentLabel,
} from '../../shared/mcp-agent-events.ts';
import { RollingWindowLimiter, type CoordinationWriteLimiter } from './rate-limit.ts';

const ONE_MINUTE_MS = 60_000;

export interface McpSession {
  agentLabel: string | null;
  /**
   * Defaults to a fresh per-session `RollingWindowLimiter`, which is what stdio uses for the
   * life of its one long-lived process session. The network HTTP transport overwrites this per
   * request with a limiter drawn from the process-lifetime `McpWriteLimiterRegistry` (C116 /
   * `server/mcp/write-limiter-registry.ts`), since a fresh `McpSession` per POST would otherwise
   * make the budget a no-op.
   */
  coordinationWrites: CoordinationWriteLimiter;
}

export function createMcpSession(options: { agentLabel?: string | null } = {}): McpSession {
  return {
    agentLabel: normalizeOptionalAgentLabel(options.agentLabel ?? null),
    coordinationWrites: new RollingWindowLimiter(
      COORDINATION_WRITE_LIMIT_PER_MINUTE,
      ONE_MINUTE_MS,
    ),
  };
}

/** Apply a label discovered during MCP `initialize` (or from `MCP_AGENT_LABEL`). */
export function setMcpSessionAgentLabel(session: McpSession, raw: string | null | undefined): void {
  session.agentLabel = normalizeOptionalAgentLabel(raw);
}

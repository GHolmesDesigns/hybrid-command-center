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
import { RollingWindowLimiter } from './rate-limit.ts';

const ONE_MINUTE_MS = 60_000;

export interface McpSession {
  agentLabel: string | null;
  coordinationWrites: RollingWindowLimiter;
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

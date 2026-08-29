/**
 * Streamable HTTP MCP transport constants and negotiation (C133 / #383).
 *
 * Notifications tip a listening client to re-read; durable resume stays on C132 change-feed
 * cursors. One-shot JSON-RPC clients that ignore session headers remain valid.
 */
export const MCP_SESSION_ID_HEADER = 'mcp-session-id';

export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

/** Default negotiated version when the client omits or sends an unknown value. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'] as const;

export type McpSupportedProtocolVersion = (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Idle HTTP MCP sessions are pruned after this much inactivity. */
export const MCP_HTTP_SESSION_TTL_MS = 30 * 60_000;

/** Hard cap on concurrent HTTP MCP sessions in one process. */
export const MCP_HTTP_SESSION_MAX = 500;

/** Per-session SSE event buffer for Last-Event-ID reconnect. */
export const MCP_SSE_EVENT_BUFFER = 64;

export function isSupportedMcpProtocolVersion(value: string): value is McpSupportedProtocolVersion {
  return (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/** Pick the client's requested version when we support it; otherwise the server default. */
export function negotiateMcpProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && isSupportedMcpProtocolVersion(requested)) {
    return requested;
  }
  return MCP_PROTOCOL_VERSION;
}

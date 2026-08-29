/**
 * Network MCP constants (C113 / #340, C133 / #383).
 *
 * Streamable HTTP MCP shares the API origin at `/api/mcp` (POST, GET SSE, DELETE). Agents
 * authenticate with the operator session cookie or a server-issued bearer; coordination writes
 * also require the agent label header. Session headers live in `shared/mcp-transport.ts`.
 */

/** Same-origin MCP JSON-RPC endpoint — no second port or origin. */
export const MCP_HTTP_PATH = '/api/mcp';

/** Header carrying the MCP bearer issued by `POST /api/auth/mcp-bearer`. */
export const MCP_BEARER_HEADER = 'authorization';

/** Required on every network MCP request; bound to audit rows and coordination writes. */
export const MCP_AGENT_LABEL_HEADER = 'x-agent-label';

/** Route that mints a bearer while the operator session is live. */
export const MCP_BEARER_ISSUE_PATH = '/api/auth/mcp-bearer';

/** Prefix for bearer tokens returned once at issuance (`hcc_mcp_…`). */
export const MCP_BEARER_TOKEN_PREFIX = 'hcc_mcp_';

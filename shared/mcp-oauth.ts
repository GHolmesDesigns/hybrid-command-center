/**
 * MCP OAuth discovery and endpoint paths (RFC 8414 / RFC 9728).
 *
 * Claude chat and Cowork custom connectors discover authorization through these well-known
 * URLs at the deployment origin, not under `/api`.
 */
import { MCP_AGENT_SCOPES, type McpAgentScope } from './mcp-agent-registry.ts';
import { MCP_HTTP_PATH } from './mcp-network.ts';

export const MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource';
export const MCP_OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN = '/.well-known/oauth-authorization-server';
export const MCP_OAUTH_AUTHORIZE_PATH = '/authorize';
export const MCP_OAUTH_TOKEN_PATH = '/token';
export const MCP_OAUTH_REGISTER_PATH = '/register';

/** Default lifetime for credentials issued through the OAuth token endpoint. */
export const MCP_OAUTH_CREDENTIAL_DAYS = 90;

/** Authorization codes expire after ten minutes — long enough to sign in and approve once. */
export const MCP_OAUTH_CODE_TTL_MS = 10 * 60 * 1000;

/** Redirect URIs Claude uses for hosted MCP connectors. */
export const MCP_OAUTH_ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
] as const;

export type McpOAuthMetadataInput = {
  issuer: string;
};

export function mcpResourceUri(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}${MCP_HTTP_PATH}`;
}

export function mcpProtectedResourceMetadataUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}${MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN}`;
}

export function buildMcpProtectedResourceMetadata(input: McpOAuthMetadataInput) {
  const issuer = input.issuer.replace(/\/+$/, '');
  return {
    resource: mcpResourceUri(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...MCP_AGENT_SCOPES],
    bearer_methods_supported: ['header'] as const,
  };
}

export function buildMcpAuthorizationServerMetadata(input: McpOAuthMetadataInput) {
  const issuer = input.issuer.replace(/\/+$/, '');
  return {
    issuer,
    authorization_endpoint: `${issuer}${MCP_OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${MCP_OAUTH_TOKEN_PATH}`,
    registration_endpoint: `${issuer}${MCP_OAUTH_REGISTER_PATH}`,
    response_types_supported: ['code'] as const,
    grant_types_supported: ['authorization_code'] as const,
    code_challenge_methods_supported: ['S256'] as const,
    token_endpoint_auth_methods_supported: ['none'] as const,
    scopes_supported: [...MCP_AGENT_SCOPES],
  };
}

export function mcpOAuthWwwAuthenticateHeader(issuer: string): string {
  const resourceMetadata = mcpProtectedResourceMetadataUrl(issuer);
  return `Bearer realm="mcp", resource_metadata="${resourceMetadata}"`;
}

/**
 * What a connector gets when it names no scope at all.
 *
 * The full set, deliberately: the operator reads this list on the approval screen and is the one who
 * grants it, so narrowing it here would break writes with no way to widen them from the UI. It is a
 * named constant rather than an inline `MCP_AGENT_SCOPES` so that narrowing it later is one line
 * with a test behind it.
 */
export const MCP_OAUTH_DEFAULT_SCOPES = MCP_AGENT_SCOPES;

export type McpOAuthScopeParseResult =
  { ok: true; scopes: McpAgentScope[] } | { ok: false; unsupported: string[] };

/**
 * Resolve the `scope` parameter of an authorization request.
 *
 * An unrecognized scope is rejected rather than dropped. Filtering it out and falling back to the
 * full set — what this did before — turned a typo, or a client carrying another server's scope
 * names, into a silent escalation to every capability: the narrowest request produced the widest
 * grant.
 */
export function parseMcpOAuthScopeParam(raw: string | undefined): McpOAuthScopeParseResult {
  if (!raw?.trim()) return { ok: true, scopes: [...MCP_OAUTH_DEFAULT_SCOPES] };
  const requested = raw.trim().split(/\s+/);
  const allowed = new Set<string>(MCP_AGENT_SCOPES);
  const unsupported = requested.filter((scope) => !allowed.has(scope));
  if (unsupported.length) return { ok: false, unsupported };
  const seen = new Set<string>();
  const scopes = requested.filter((scope): scope is McpAgentScope => {
    if (seen.has(scope)) return false;
    seen.add(scope);
    return true;
  });
  return { ok: true, scopes };
}

/**
 * MCP OAuth discovery and endpoint paths (RFC 8414 / RFC 9728).
 *
 * Claude chat and Cowork custom connectors discover authorization through these well-known
 * URLs at the deployment origin, not under `/api`.
 */
import { MCP_AGENT_SCOPES, type McpAgentScope } from './mcp-agent-registry.ts';
import { MCP_HTTP_PATH } from './mcp-network.ts';

export const MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN =
  '/.well-known/oauth-protected-resource';
export const MCP_OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN =
  '/.well-known/oauth-authorization-server';
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

export function parseMcpOAuthScopeParam(raw: string | undefined): McpAgentScope[] {
  if (!raw?.trim()) return [...MCP_AGENT_SCOPES];
  const requested = raw.trim().split(/\s+/);
  const allowed = new Set<string>(MCP_AGENT_SCOPES);
  const scopes = requested.filter((scope): scope is McpAgentScope => allowed.has(scope));
  return scopes.length ? scopes : [...MCP_AGENT_SCOPES];
}

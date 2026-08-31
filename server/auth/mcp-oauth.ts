/**
 * MCP OAuth authorization server for Claude chat and Cowork connectors.
 *
 * Issues the same scoped `hcc_mcp_` bearer tokens as Agents → Agent connection setup, but
 * through the OAuth authorization_code + PKCE flow those surfaces expect.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { mcpAgentScopesSchema, type McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import {
  MCP_OAUTH_ALLOWED_REDIRECT_URIS,
  MCP_OAUTH_CODE_TTL_MS,
  MCP_OAUTH_CREDENTIAL_DAYS,
  parseMcpOAuthScopeParam,
} from '../../shared/mcp-oauth.ts';
import {
  createMcpAgentCredential,
  revokeActiveMcpAgentCredentialsForLabel,
} from './mcp-agent-credentials.ts';

export const MCP_OAUTH_CLIENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  revoked_at TEXT
)`;

export const MCP_OAUTH_CODES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scopes TEXT NOT NULL,
  operator_session_hash TEXT NOT NULL,
  agent_label TEXT NOT NULL,
  oauth_state TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
)`;

export class McpOAuthError extends Error {
  readonly errorCode:
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'access_denied';

  constructor(
    message: string,
    errorCode:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unauthorized_client'
      | 'unsupported_grant_type'
      | 'access_denied' = 'invalid_request',
  ) {
    super(message);
    this.name = 'McpOAuthError';
    this.errorCode = errorCode;
  }
}

type OAuthClientRow = {
  client_id: string;
  redirect_uris: string;
  client_name: string | null;
  token_endpoint_auth_method: string;
  created_at: string;
  revoked_at: string | null;
};

type OAuthCodeRow = {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scopes: string;
  operator_session_hash: string;
  agent_label: string;
  oauth_state: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

const redirectUriSchema = z
  .string()
  .url()
  .refine(
    (uri) => MCP_OAUTH_ALLOWED_REDIRECT_URIS.includes(uri as (typeof MCP_OAUTH_ALLOWED_REDIRECT_URIS)[number]),
    'redirect_uri is not an allowed MCP connector callback.',
  );

const registerClientSchema = z.object({
  redirect_uris: z.array(redirectUriSchema).min(1).max(8),
  client_name: z.string().trim().min(1).max(128).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.literal('authorization_code')).optional(),
  response_types: z.array(z.literal('code')).optional(),
});

export type RegisteredMcpOAuthClient = {
  clientId: string;
  redirectUris: readonly string[];
  clientName: string | null;
  createdAt: string;
};

export function purgeExpiredMcpOAuthCodes(db: Db, now = Date.now()): number {
  const result = db
    .prepare('DELETE FROM mcp_oauth_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL')
    .run(iso(now));
  return Number(result.changes ?? 0);
}

export function registerMcpOAuthClient(
  db: Db,
  body: unknown,
  now = Date.now(),
): RegisteredMcpOAuthClient {
  const parsed = registerClientSchema.parse(body);
  const clientId = crypto.randomUUID();
  const createdAt = iso(now);
  db.prepare(
    `INSERT INTO mcp_oauth_clients (client_id, redirect_uris, client_name, token_endpoint_auth_method, created_at, revoked_at)
     VALUES (?, ?, ?, 'none', ?, NULL)`,
  ).run(clientId, JSON.stringify(parsed.redirect_uris), parsed.client_name ?? null, createdAt);
  return {
    clientId,
    redirectUris: parsed.redirect_uris,
    clientName: parsed.client_name ?? null,
    createdAt,
  };
}

export function readMcpOAuthClient(db: Db, clientId: string): RegisteredMcpOAuthClient | null {
  const row = db
    .prepare(
      `SELECT client_id, redirect_uris, client_name, token_endpoint_auth_method, created_at, revoked_at
       FROM mcp_oauth_clients WHERE client_id = ?`,
    )
    .get(clientId) as OAuthClientRow | undefined;
  if (!row || row.revoked_at) return null;
  return {
    clientId: row.client_id,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    clientName: row.client_name,
    createdAt: row.created_at,
  };
}

function verifyRedirectUri(client: RegisteredMcpOAuthClient, redirectUri: string): void {
  if (!client.redirectUris.includes(redirectUri)) {
    throw new McpOAuthError('redirect_uri does not match this client.', 'invalid_grant');
  }
}

/** Map a connector client name to a valid agent label, with a stable fallback. */
export function agentLabelForOAuthClient(client: RegisteredMcpOAuthClient): string {
  const fallback = `claude-oauth-${client.clientId.slice(0, 8)}`;
  const raw = client.clientName?.trim();
  if (!raw) return fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 64);
  return normalized.length ? normalized : fallback;
}

export type PendingMcpOAuthAuthorization = {
  clientId: string;
  redirectUri: string;
  scopes: McpAgentScope[];
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  oauthState: string;
  agentLabel: string;
};

const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().uuid(),
  redirect_uri: redirectUriSchema,
  state: z.string().min(1).max(512),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  scope: z.string().optional(),
});

export function parseAuthorizeRequest(query: Record<string, unknown>): PendingMcpOAuthAuthorization {
  const parsed = authorizeQuerySchema.parse(query);
  return {
    clientId: parsed.client_id,
    redirectUri: parsed.redirect_uri,
    scopes: mcpAgentScopesSchema.parse(parseMcpOAuthScopeParam(parsed.scope)),
    codeChallenge: parsed.code_challenge,
    codeChallengeMethod: parsed.code_challenge_method,
    oauthState: parsed.state,
    agentLabel: '',
  };
}

export function beginMcpOAuthAuthorization(
  db: Db,
  input: PendingMcpOAuthAuthorization & {
    operatorSessionHash: string;
    now?: number;
  },
): { code: string } {
  purgeExpiredMcpOAuthCodes(db, input.now);
  const client = readMcpOAuthClient(db, input.clientId);
  if (!client) throw new McpOAuthError('Unknown OAuth client.', 'invalid_client');
  verifyRedirectUri(client, input.redirectUri);
  const agentLabel = input.agentLabel || agentLabelForOAuthClient(client);
  const now = input.now ?? Date.now();
  const code = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO mcp_oauth_codes (
      code, client_id, redirect_uri, code_challenge, code_challenge_method, scopes,
      operator_session_hash, agent_label, oauth_state, issued_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    code,
    input.clientId,
    input.redirectUri,
    input.codeChallenge,
    input.codeChallengeMethod,
    JSON.stringify(input.scopes),
    input.operatorSessionHash,
    agentLabel,
    input.oauthState,
    iso(now),
    iso(now + MCP_OAUTH_CODE_TTL_MS),
  );
  return { code };
}

const tokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: redirectUriSchema,
  client_id: z.string().uuid(),
  code_verifier: z.string().min(43).max(128),
});

function verifyPkce(codeChallenge: string, codeVerifier: string): void {
  const digest = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const left = Buffer.from(digest);
  const right = Buffer.from(codeChallenge);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new McpOAuthError('PKCE verification failed.', 'invalid_grant');
  }
}

export type McpOAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
};

export function exchangeMcpOAuthCode(
  db: Db,
  body: Record<string, unknown>,
  options: { sessionSecret: string; now?: number },
): McpOAuthTokenResponse {
  purgeExpiredMcpOAuthCodes(db, options.now);
  const parsed = tokenRequestSchema.parse(body);
  const client = readMcpOAuthClient(db, parsed.client_id);
  if (!client) throw new McpOAuthError('Unknown OAuth client.', 'invalid_client');
  verifyRedirectUri(client, parsed.redirect_uri);

  const row = db
    .prepare(
      `SELECT code, client_id, redirect_uri, code_challenge, code_challenge_method, scopes,
              operator_session_hash, agent_label, oauth_state, issued_at, expires_at, consumed_at
       FROM mcp_oauth_codes WHERE code = ?`,
    )
    .get(parsed.code) as OAuthCodeRow | undefined;
  if (!row || row.consumed_at) {
    throw new McpOAuthError('Authorization code is invalid or already used.', 'invalid_grant');
  }
  if (row.client_id !== parsed.client_id || row.redirect_uri !== parsed.redirect_uri) {
    throw new McpOAuthError('Authorization code does not match this client.', 'invalid_grant');
  }
  const now = options.now ?? Date.now();
  if (Date.parse(row.expires_at) <= now) {
    throw new McpOAuthError('Authorization code has expired.', 'invalid_grant');
  }
  verifyPkce(row.code_challenge, parsed.code_verifier);

  const scopes = mcpAgentScopesSchema.parse(JSON.parse(row.scopes) as unknown);
  const expiresAt = iso(now + MCP_OAUTH_CREDENTIAL_DAYS * 86_400_000);

  db.prepare('UPDATE mcp_oauth_codes SET consumed_at = ? WHERE code = ?').run(iso(now), row.code);
  revokeActiveMcpAgentCredentialsForLabel(db, row.agent_label, now);
  const issued = createMcpAgentCredential(db, {
    label: row.agent_label,
    scopes,
    expiresAt,
    sessionSecret: options.sessionSecret,
    now,
  });

  return {
    access_token: issued.rawToken,
    token_type: 'Bearer',
    expires_in: MCP_OAUTH_CREDENTIAL_DAYS * 86_400,
    scope: scopes.join(' '),
  };
}

export function registrationResponse(client: RegisteredMcpOAuthClient): Record<string, unknown> {
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
    redirect_uris: client.redirectUris,
    client_name: client.clientName ?? undefined,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
}

export function redirectWithAuthorizationCode(input: {
  redirectUri: string;
  code: string;
  state: string;
}): string {
  const url = new URL(input.redirectUri);
  url.searchParams.set('code', input.code);
  url.searchParams.set('state', input.state);
  return url.toString();
}

export function redirectWithOAuthError(input: {
  redirectUri: string;
  error: 'access_denied' | 'invalid_request';
  state: string;
  description?: string;
}): string {
  const url = new URL(input.redirectUri);
  url.searchParams.set('error', input.error);
  url.searchParams.set('state', input.state);
  if (input.description) url.searchParams.set('error_description', input.description);
  return url.toString();
}

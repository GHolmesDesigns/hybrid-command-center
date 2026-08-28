/** Scoped, server-bound MCP identities (C118 / #368). */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import {
  MCP_AGENT_SCOPES,
  mcpAgentScopesSchema,
  type McpAgentCredentialSummary,
  type McpAgentScope,
} from '../../shared/mcp-agent-registry.ts';
import { MCP_BEARER_TOKEN_PREFIX } from '../../shared/mcp-network.ts';
import { hashMcpBearerToken } from './mcp-bearers.ts';

type CredentialRow = {
  id: string;
  agent_id: string;
  display_label: string;
  scopes: string;
  issued_at: string;
  expires_at: string;
  credential_last_used_at: string | null;
  registration_last_used_at: string | null;
  last_origin: string | null;
  revoked_at: string | null;
};

export type ResolvedMcpAgentCredential = {
  credentialId: string;
  tokenHash: string;
  agentId: string;
  agentLabel: string;
  scopes: readonly McpAgentScope[];
  isBootstrap: boolean;
};

export const OPERATOR_BOOTSTRAP_AGENT_ID = 'operator-session-bootstrap';
export const OPERATOR_BOOTSTRAP_AGENT_LABEL = 'operator-session';

/** Re-issuing a label that still has an active credential — revoke first or pick another name. */
export class McpAgentLabelTakenError extends Error {
  readonly status = 409 as const;
  constructor(label: string) {
    super(
      `An active MCP agent credential already uses the name “${label}”. Revoke it first, or choose a different name.`,
    );
    this.name = 'McpAgentLabelTakenError';
  }
}

export function operatorBootstrapCredential(tokenHash: string): ResolvedMcpAgentCredential {
  return {
    credentialId: tokenHash,
    tokenHash,
    agentId: OPERATOR_BOOTSTRAP_AGENT_ID,
    agentLabel: OPERATOR_BOOTSTRAP_AGENT_LABEL,
    scopes: ['coordination:read', 'coordination:write'],
    isBootstrap: true,
  };
}

const iso = (now: number) => new Date(now).toISOString();
const parseScopes = (raw: string): McpAgentScope[] =>
  mcpAgentScopesSchema.parse(JSON.parse(raw) as unknown);
const orderedScopes = (scopes: readonly McpAgentScope[]): McpAgentScope[] =>
  MCP_AGENT_SCOPES.filter((scope) => scopes.includes(scope));

const toSummary = (row: CredentialRow): McpAgentCredentialSummary => ({
  id: row.id,
  agentId: row.agent_id,
  label: row.display_label,
  scopes: parseScopes(row.scopes),
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.credential_last_used_at ?? row.registration_last_used_at,
  lastOrigin: row.last_origin,
  revokedAt: row.revoked_at,
});

const SELECT_CREDENTIAL = `SELECT c.id, c.agent_id, r.display_label, c.scopes, c.issued_at,
  c.expires_at, c.last_used_at AS credential_last_used_at,
  r.last_used_at AS registration_last_used_at, r.last_origin, c.revoked_at
  FROM agent_credentials c JOIN agent_registrations r ON r.id=c.agent_id`;

export function createMcpAgentCredential(
  db: Db,
  options: {
    label: string;
    scopes: readonly McpAgentScope[];
    expiresAt: string;
    sessionSecret: string;
    now?: number;
  },
): { rawToken: string; credential: McpAgentCredentialSummary } {
  const now = options.now ?? Date.now();
  if (Date.parse(options.expiresAt) <= now)
    throw new Error('Credential expiry must be in the future.');
  const scopes = orderedScopes(mcpAgentScopesSchema.parse(options.scopes));
  const rawToken = `${MCP_BEARER_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const tokenHash = hashMcpBearerToken(rawToken, options.sessionSecret);
  const credentialId = crypto.randomUUID();
  const issuedAt = iso(now);

  // Labels are unique for the handoff board. Revoke only soft-deletes the credential row, so
  // re-issue must reuse the registration when nothing active still holds the name — otherwise
  // the UNIQUE index on display_label fails and the Settings form surfaces a generic 500.
  let agentId = '';
  transaction(db, () => {
    const existing = db
      .prepare(
        `SELECT id FROM agent_registrations WHERE display_label = ? COLLATE NOCASE`,
      )
      .get(options.label) as { id: string } | undefined;
    if (existing) {
      const active = db
        .prepare(
          `SELECT id FROM agent_credentials
           WHERE agent_id = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(existing.id, issuedAt) as { id: string } | undefined;
      if (active) throw new McpAgentLabelTakenError(options.label);
      agentId = existing.id;
      db.prepare('UPDATE agent_registrations SET display_label=? WHERE id=?').run(
        options.label,
        agentId,
      );
    } else {
      agentId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO agent_registrations(id, display_label, created_at, last_used_at, last_origin)
         VALUES(?,?,?,NULL,NULL)`,
      ).run(agentId, options.label, issuedAt);
    }
    db.prepare(
      `INSERT INTO agent_credentials(id, agent_id, token_hash, scopes, issued_at, expires_at,
       last_used_at, revoked_at) VALUES(?,?,?,?,?,?,NULL,NULL)`,
    ).run(credentialId, agentId, tokenHash, JSON.stringify(scopes), issuedAt, options.expiresAt);
  });

  return {
    rawToken,
    credential: {
      id: credentialId,
      agentId,
      label: options.label,
      scopes,
      issuedAt,
      expiresAt: options.expiresAt,
      lastUsedAt: null,
      lastOrigin: null,
      revokedAt: null,
    },
  };
}

export function resolveMcpAgentCredential(
  db: Db,
  options: { rawToken: string; sessionSecret: string; origin: string | null; now?: number },
): ResolvedMcpAgentCredential | null {
  if (!options.rawToken.startsWith(MCP_BEARER_TOKEN_PREFIX)) return null;
  const now = options.now ?? Date.now();
  const tokenHash = hashMcpBearerToken(options.rawToken, options.sessionSecret);
  const row = db.prepare(`${SELECT_CREDENTIAL} WHERE c.token_hash=?`).get(tokenHash) as
    CredentialRow | undefined;
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= now) return null;
  const usedAt = iso(now);
  transaction(db, () => {
    db.prepare('UPDATE agent_credentials SET last_used_at=? WHERE id=?').run(usedAt, row.id);
    db.prepare('UPDATE agent_registrations SET last_used_at=?, last_origin=? WHERE id=?').run(
      usedAt,
      options.origin,
      row.agent_id,
    );
  });
  return {
    credentialId: row.id,
    tokenHash,
    agentId: row.agent_id,
    agentLabel: row.display_label,
    scopes: parseScopes(row.scopes),
    isBootstrap: false,
  };
}

export function listMcpAgentCredentials(db: Db, now = Date.now()): McpAgentCredentialSummary[] {
  return (
    db
      .prepare(
        `${SELECT_CREDENTIAL} WHERE c.revoked_at IS NULL AND c.expires_at > ?
         ORDER BY r.display_label, c.issued_at`,
      )
      .all(iso(now)) as CredentialRow[]
  ).map(toSummary);
}

export function renameMcpAgentRegistration(db: Db, agentId: string, label: string): boolean {
  return (
    db.prepare('UPDATE agent_registrations SET display_label=? WHERE id=?').run(label, agentId)
      .changes > 0
  );
}

export function revokeMcpAgentCredential(db: Db, credentialId: string, now = Date.now()): boolean {
  return (
    db
      .prepare('UPDATE agent_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .run(iso(now), credentialId).changes > 0
  );
}

export function hasMcpAgentScope(
  scopes: readonly McpAgentScope[],
  required: McpAgentScope,
): boolean {
  return scopes.includes(required);
}

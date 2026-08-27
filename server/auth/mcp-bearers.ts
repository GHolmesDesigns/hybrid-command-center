/**
 * MCP bearer tokens bound to operator sessions (C113 / #340).
 *
 * The raw bearer is returned once at issuance; SQLite stores only an HMAC-SHA256 hash peppered
 * with the session secret. Bearers inherit the parent session's revocation — logout, password
 * change, restore, and idle/absolute expiry all invalidate them.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { MCP_BEARER_TOKEN_PREFIX } from '../../shared/mcp-network.ts';
import { hashSessionToken, lookupSessionByHash, type OperatorSessionRecord } from './sessions.ts';

/**
 * Fresh-install / additive CREATE for `operator_mcp_bearers`. Exported so `server/db.ts` can paste
 * the same SQL into `tableSchema` without a second definition drifting.
 */
export const OPERATOR_MCP_BEARERS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS operator_mcp_bearers (
  token_hash TEXT PRIMARY KEY,
  session_token_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT
)`;

export type OperatorMcpBearerRecord = {
  tokenHash: string;
  sessionTokenHash: string;
  issuedAt: string;
  revokedAt: string | null;
};

type BearerRow = {
  token_hash: string;
  session_token_hash: string;
  issued_at: string;
  revoked_at: string | null;
};

const toRecord = (row: BearerRow): OperatorMcpBearerRecord => ({
  tokenHash: row.token_hash,
  sessionTokenHash: row.session_token_hash,
  issuedAt: row.issued_at,
  revokedAt: row.revoked_at,
});

const iso = (ms: number) => new Date(ms).toISOString();

/** HMAC-SHA256 of the raw bearer token, peppered with the session secret. */
export function hashMcpBearerToken(rawToken: string, sessionSecret: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(rawToken, 'utf8').digest('hex');
}

function randomBearerToken(): string {
  return `${MCP_BEARER_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export function createMcpBearer(
  db: Db,
  options: {
    sessionTokenHash: string;
    sessionSecret: string;
    now?: number;
  },
): { rawToken: string; record: OperatorMcpBearerRecord } {
  const now = options.now ?? Date.now();
  const rawToken = randomBearerToken();
  const tokenHash = hashMcpBearerToken(rawToken, options.sessionSecret);
  const issuedAt = iso(now);

  db.prepare(
    `INSERT INTO operator_mcp_bearers (token_hash, session_token_hash, issued_at, revoked_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(tokenHash, options.sessionTokenHash, issuedAt);

  return {
    rawToken,
    record: {
      tokenHash,
      sessionTokenHash: options.sessionTokenHash,
      issuedAt,
      revokedAt: null,
    },
  };
}

export type ResolvedMcpBearerAuth = {
  bearer: OperatorMcpBearerRecord;
  session: OperatorSessionRecord;
};

/**
 * Resolve a live bearer to its parent session. Returns null when the bearer or session is missing,
 * revoked, or expired.
 */
export function resolveMcpBearer(
  db: Db,
  options: {
    rawToken: string;
    sessionSecret: string;
    now?: number;
  },
): ResolvedMcpBearerAuth | null {
  if (!options.rawToken.startsWith(MCP_BEARER_TOKEN_PREFIX)) return null;
  const now = options.now ?? Date.now();
  const tokenHash = hashMcpBearerToken(options.rawToken, options.sessionSecret);
  const row = db
    .prepare('SELECT * FROM operator_mcp_bearers WHERE token_hash = ?')
    .get(tokenHash) as BearerRow | undefined;
  if (!row || row.revoked_at) return null;

  const session = lookupSessionByHash(db, { tokenHash: row.session_token_hash, now });
  if (!session) return null;

  return {
    bearer: toRecord(row),
    session,
  };
}

export function revokeBearersForSession(
  db: Db,
  sessionTokenHash: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE operator_mcp_bearers SET revoked_at = COALESCE(revoked_at, ?) WHERE session_token_hash = ?`,
  ).run(iso(now), sessionTokenHash);
}

export function revokeAllMcpBearers(db: Db, now: number = Date.now()): void {
  db.prepare(
    `UPDATE operator_mcp_bearers SET revoked_at = COALESCE(revoked_at, ?) WHERE revoked_at IS NULL`,
  ).run(iso(now));
}

/** Parse `Authorization: Bearer hcc_mcp_…` when present. */
export function readMcpBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!raw?.trim()) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim());
  return match?.[1] ?? null;
}

export { hashSessionToken };

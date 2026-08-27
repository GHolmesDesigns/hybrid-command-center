/**
 * SQLite-backed operator sessions (C51 / #177).
 *
 * The cookie holds a raw random token; this table stores only an HMAC-SHA256 of that token
 * (session secret as pepper) plus a CSRF token bound to the row. Idle and absolute expiry are
 * UTC ISO timestamps; a successful lookup touches `last_seen_at` and extends idle expiry.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '../../shared/auth.ts';

/**
 * Fresh-install / additive CREATE for `operator_sessions`. Exported so `server/db.ts` can paste
 * the same SQL into `tableSchema` without a second definition drifting.
 */
export const OPERATOR_SESSIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  client_address TEXT
)`;

export type OperatorSessionRecord = {
  tokenHash: string;
  csrfToken: string;
  issuedAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  clientAddress: string | null;
};

type SessionRow = {
  token_hash: string;
  csrf_token: string;
  issued_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  client_address: string | null;
};

const toRecord = (row: SessionRow): OperatorSessionRecord => ({
  tokenHash: row.token_hash,
  csrfToken: row.csrf_token,
  issuedAt: row.issued_at,
  lastSeenAt: row.last_seen_at,
  idleExpiresAt: row.idle_expires_at,
  absoluteExpiresAt: row.absolute_expires_at,
  revokedAt: row.revoked_at,
  clientAddress: row.client_address,
});

const iso = (ms: number) => new Date(ms).toISOString();

/** HMAC-SHA256 of the raw cookie token, peppered with the session secret. */
export function hashSessionToken(rawToken: string, sessionSecret: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(rawToken, 'utf8').digest('hex');
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function createSession(
  db: Db,
  options: {
    sessionSecret: string;
    clientAddress: string | null;
    now?: number;
  },
): { rawToken: string; csrfToken: string; record: OperatorSessionRecord } {
  const now = options.now ?? Date.now();
  const rawToken = randomToken();
  const csrfToken = randomToken();
  const tokenHash = hashSessionToken(rawToken, options.sessionSecret);
  const issuedAt = iso(now);
  const idleExpiresAt = iso(now + SESSION_IDLE_TIMEOUT_MS);
  const absoluteExpiresAt = iso(now + SESSION_ABSOLUTE_TIMEOUT_MS);

  db.prepare(
    `INSERT INTO operator_sessions (
      token_hash, csrf_token, issued_at, last_seen_at, idle_expires_at, absolute_expires_at,
      revoked_at, client_address
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    tokenHash,
    csrfToken,
    issuedAt,
    issuedAt,
    idleExpiresAt,
    absoluteExpiresAt,
    options.clientAddress,
  );

  return {
    rawToken,
    csrfToken,
    record: {
      tokenHash,
      csrfToken,
      issuedAt,
      lastSeenAt: issuedAt,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
      clientAddress: options.clientAddress,
    },
  };
}

/**
 * Look up a live session by raw cookie token. Expired or revoked rows return null.
 * A successful lookup refreshes `last_seen_at` and idle expiry without extending absolute expiry.
 */
export function lookupSession(
  db: Db,
  options: {
    rawToken: string;
    sessionSecret: string;
    now?: number;
  },
): OperatorSessionRecord | null {
  if (!options.rawToken) return null;
  const now = options.now ?? Date.now();
  const tokenHash = hashSessionToken(options.rawToken, options.sessionSecret);
  const row = db.prepare('SELECT * FROM operator_sessions WHERE token_hash = ?').get(tokenHash) as
    SessionRow | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;

  const nowIso = iso(now);
  if (row.idle_expires_at <= nowIso || row.absolute_expires_at <= nowIso) return null;

  const idleExpiresAt = iso(now + SESSION_IDLE_TIMEOUT_MS);
  // Idle may not push past absolute expiry.
  const cappedIdle =
    idleExpiresAt < row.absolute_expires_at ? idleExpiresAt : row.absolute_expires_at;

  db.prepare(
    `UPDATE operator_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ?`,
  ).run(nowIso, cappedIdle, tokenHash);

  return toRecord({
    ...row,
    last_seen_at: nowIso,
    idle_expires_at: cappedIdle,
  });
}

/**
 * Look up a live session by its stored token hash. Used when only the hash is known (MCP bearer
 * binding). Refreshes idle expiry the same way `lookupSession` does.
 */
export function lookupSessionByHash(
  db: Db,
  options: { tokenHash: string; now?: number },
): OperatorSessionRecord | null {
  if (!options.tokenHash) return null;
  const now = options.now ?? Date.now();
  const row = db
    .prepare('SELECT * FROM operator_sessions WHERE token_hash = ?')
    .get(options.tokenHash) as SessionRow | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;

  const nowIso = iso(now);
  if (row.idle_expires_at <= nowIso || row.absolute_expires_at <= nowIso) return null;

  const idleExpiresAt = iso(now + SESSION_IDLE_TIMEOUT_MS);
  const cappedIdle =
    idleExpiresAt < row.absolute_expires_at ? idleExpiresAt : row.absolute_expires_at;

  db.prepare(
    `UPDATE operator_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ?`,
  ).run(nowIso, cappedIdle, options.tokenHash);

  return toRecord({
    ...row,
    last_seen_at: nowIso,
    idle_expires_at: cappedIdle,
  });
}

export function revokeSession(db: Db, tokenHash: string, now: number = Date.now()): void {
  db.prepare(
    `UPDATE operator_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?`,
  ).run(iso(now), tokenHash);
}

export function revokeAllSessions(db: Db, now: number = Date.now()): void {
  db.prepare(
    `UPDATE operator_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE revoked_at IS NULL`,
  ).run(iso(now));
}

/** Delete rows that are past idle or absolute expiry, or already revoked. */
export function purgeExpiredSessions(db: Db, now: number = Date.now()): number {
  const nowIso = iso(now);
  const result = db
    .prepare(
      `DELETE FROM operator_sessions
       WHERE revoked_at IS NOT NULL
          OR idle_expires_at <= ?
          OR absolute_expires_at <= ?`,
    )
    .run(nowIso, nowIso);
  return Number(result.changes ?? 0);
}

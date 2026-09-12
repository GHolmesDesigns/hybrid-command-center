/**
 * Operator authentication orchestration (C51 / #177).
 *
 * Password hash lives in env (`OPERATOR_PASSWORD_HASH`) for production bind, or in the
 * `operator_password_hash` settings row for loopback bootstrap / testing. Env always wins when set.
 * Login failures are generic — nothing distinguishes a missing hash from a wrong password.
 */
import type { Db } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import type { AuthStatusResponse } from '../../shared/auth.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { loginRateLimiter } from './login-rate-limit.ts';
import {
  createSession,
  lookupSession,
  revokeAllSessions,
  revokeSession,
  type OperatorSessionRecord,
} from './sessions.ts';
import { revokeAllMcpBearers, revokeBearersForSession } from './mcp-bearers.ts';

export const OPERATOR_PASSWORD_HASH_SETTING_KEY = 'operator_password_hash';

export type LoginSuccess = {
  ok: true;
  rawToken: string;
  csrfToken: string;
  record: OperatorSessionRecord;
};

export type LoginFailure = {
  ok: false;
  error: string;
  retryAfterMs: number;
};

export type LoginResult = LoginSuccess | LoginFailure;

const GENERIC_LOGIN_FAILURE = 'Invalid credentials.';

/** Env hash wins when present; otherwise the settings row (loopback bootstrap). */
export function getPasswordHash(db: Db, envHash?: string): string | null {
  const fromEnv = envHash?.trim();
  if (fromEnv) return fromEnv;
  const stored = getSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY);
  return stored?.trim() ? stored : null;
}

export function passwordIsConfigured(db: Db, envHash?: string): boolean {
  return getPasswordHash(db, envHash) !== null;
}

export async function login(
  db: Db,
  options: {
    password: string;
    clientAddress: string;
    sessionSecret: string;
    envHash?: string;
    now?: number;
  },
): Promise<LoginResult> {
  const now = options.now ?? Date.now();
  const limited = loginRateLimiter.check(options.clientAddress, now);
  if (!limited.allowed) {
    return {
      ok: false,
      error: GENERIC_LOGIN_FAILURE,
      retryAfterMs: limited.retryAfterMs,
    };
  }

  const hash = getPasswordHash(db, options.envHash);
  const accepted = hash ? await verifyPassword(hash, options.password) : false;
  if (!accepted) {
    loginRateLimiter.recordFailure(options.clientAddress, now);
    // The failure itself is a 401. Progressive delay and lockout apply to the *next* attempt,
    // which `check` above will refuse — do not re-check here or every wrong password becomes 429.
    return {
      ok: false,
      error: GENERIC_LOGIN_FAILURE,
      retryAfterMs: 0,
    };
  }

  loginRateLimiter.clear(options.clientAddress);
  const session = createSession(db, {
    sessionSecret: options.sessionSecret,
    clientAddress: options.clientAddress,
    now,
  });
  return {
    ok: true,
    rawToken: session.rawToken,
    csrfToken: session.csrfToken,
    record: session.record,
  };
}

export function logout(db: Db, options: { tokenHash: string | null; now?: number }): void {
  const now = options.now ?? Date.now();
  if (options.tokenHash) {
    revokeBearersForSession(db, options.tokenHash, now);
    revokeSession(db, options.tokenHash, now);
  }
}

export type ChangePasswordFailure = 'invalid-current-password' | 'env-managed';

/**
 * Change the operator password: verify the current one, store the new hash, revoke every session.
 *
 * Refuses when `OPERATOR_PASSWORD_HASH` is set, because `getPasswordHash` always prefers the env
 * value: writing the settings row would report success while leaving the old password working.
 * The refusal comes after verification so an unauthenticated caller learns nothing about the host.
 */
export async function changePassword(
  db: Db,
  options: {
    currentPassword: string;
    newPassword: string;
    envHash?: string;
    now?: number;
  },
): Promise<{ ok: true } | { ok: false; error: string; reason: ChangePasswordFailure }> {
  const hash = getPasswordHash(db, options.envHash);
  if (!hash || !(await verifyPassword(hash, options.currentPassword))) {
    return {
      ok: false,
      error: 'Current password is incorrect.',
      reason: 'invalid-current-password',
    };
  }
  if (options.envHash?.trim()) {
    return {
      ok: false,
      error:
        'OPERATOR_PASSWORD_HASH is set in the environment; rotate it there and restart. ' +
        'No password was changed and no sessions were revoked.',
      reason: 'env-managed',
    };
  }
  const next = await hashPassword(options.newPassword);
  setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, next);
  revokeAllMcpBearers(db, options.now ?? Date.now());
  revokeAllSessions(db, options.now ?? Date.now());
  return { ok: true };
}

/**
 * Bootstrap / compromise reset: set a new hash and revoke every session without verifying the old one.
 * Does not clear an env-provided hash — the operator must rotate `OPERATOR_PASSWORD_HASH` separately.
 */
export async function resetPassword(
  db: Db,
  options: { newPassword: string; now?: number },
): Promise<void> {
  const next = await hashPassword(options.newPassword);
  setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, next);
  revokeAllMcpBearers(db, options.now ?? Date.now());
  revokeAllSessions(db, options.now ?? Date.now());
}

export function authStatus(options: {
  authRequired: boolean;
  session: OperatorSessionRecord | null;
}): AuthStatusResponse {
  return {
    authRequired: options.authRequired,
    authenticated: options.session !== null,
    csrfToken: options.session?.csrfToken ?? null,
  };
}

export function sessionFromRawToken(
  db: Db,
  options: { rawToken: string | null; sessionSecret: string; now?: number },
): OperatorSessionRecord | null {
  if (!options.rawToken || !options.sessionSecret) return null;
  return lookupSession(db, {
    rawToken: options.rawToken,
    sessionSecret: options.sessionSecret,
    now: options.now,
  });
}

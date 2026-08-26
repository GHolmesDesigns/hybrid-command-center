import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { loginRateLimiter } from './login-rate-limit.ts';
import { hashPassword } from './password.ts';
import {
  OPERATOR_PASSWORD_HASH_SETTING_KEY,
  authStatus,
  changePassword,
  getPasswordHash,
  login,
  logout,
  passwordIsConfigured,
  resetPassword,
  sessionFromRawToken,
} from './service.ts';
import { lookupSession } from './sessions.ts';

const SECRET = 'session-secret-at-least-thirty-two-chars!!';
const PASSWORD = 'operator-password-ok';

describe('auth service', () => {
  let db: Db;
  let hash: string;

  beforeEach(async () => {
    db = createDb(':memory:');
    hash = await hashPassword(PASSWORD);
    loginRateLimiter.reset();
  });

  afterEach(() => {
    db.close();
    loginRateLimiter.reset();
  });

  it('getPasswordHash prefers the env hash over the settings row', () => {
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, 'settings-hash');
    expect(getPasswordHash(db, 'env-hash')).toBe('env-hash');
    expect(getPasswordHash(db)).toBe('settings-hash');
    expect(passwordIsConfigured(db)).toBe(true);
    expect(passwordIsConfigured(db, '')).toBe(true);
  });

  it('login succeeds with the correct password and creates a session', async () => {
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, hash);
    const result = await login(db, {
      password: PASSWORD,
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csrfToken).toBeTruthy();
    expect(
      lookupSession(db, { rawToken: result.rawToken, sessionSecret: SECRET, now: 1_001 }),
    ).not.toBeNull();
  });

  it('login fails generically for a wrong password and does not create a session', async () => {
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, hash);
    const result = await login(db, {
      password: 'wrong-password!!',
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 1_000,
    });
    expect(result).toMatchObject({ ok: false, error: 'Invalid credentials.' });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM operator_sessions').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('login fails generically when no hash is configured', async () => {
    const result = await login(db, {
      password: PASSWORD,
      clientAddress: '1.1.1.1',
      sessionSecret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it('logout revokes the session', async () => {
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, hash);
    const result = await login(db, {
      password: PASSWORD,
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    logout(db, { tokenHash: result.record.tokenHash, now: 10 });
    expect(
      sessionFromRawToken(db, { rawToken: result.rawToken, sessionSecret: SECRET, now: 20 }),
    ).toBeNull();
  });

  it('changePassword verifies the current password, stores a new hash, and revokes sessions', async () => {
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, hash);
    const session = await login(db, {
      password: PASSWORD,
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 0,
    });
    expect(session.ok).toBe(true);

    const refused = await changePassword(db, {
      currentPassword: 'not-the-password',
      newPassword: 'brand-new-password',
    });
    expect(refused.ok).toBe(false);

    const changed = await changePassword(db, {
      currentPassword: PASSWORD,
      newPassword: 'brand-new-password',
      now: 50,
    });
    expect(changed.ok).toBe(true);
    expect(getSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY)).not.toBe(hash);
    if (session.ok) {
      expect(
        lookupSession(db, { rawToken: session.rawToken, sessionSecret: SECRET, now: 60 }),
      ).toBeNull();
    }

    const again = await login(db, {
      password: 'brand-new-password',
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 70,
    });
    expect(again.ok).toBe(true);
  });

  it('resetPassword sets a new hash and revokes every session without the old password', async () => {
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, hash);
    const session = await login(db, {
      password: PASSWORD,
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 0,
    });
    await resetPassword(db, { newPassword: 'recovery-password!', now: 10 });
    if (session.ok) {
      expect(
        lookupSession(db, { rawToken: session.rawToken, sessionSecret: SECRET, now: 20 }),
      ).toBeNull();
    }
    const recovered = await login(db, {
      password: 'recovery-password!',
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 30,
    });
    expect(recovered.ok).toBe(true);
  });

  it('authStatus reports requirement, authentication, and CSRF', () => {
    expect(authStatus({ authRequired: false, session: null })).toEqual({
      authRequired: false,
      authenticated: false,
      csrfToken: null,
    });
    expect(
      authStatus({
        authRequired: true,
        session: {
          tokenHash: 'h',
          csrfToken: 'csrf',
          issuedAt: '',
          lastSeenAt: '',
          idleExpiresAt: '',
          absoluteExpiresAt: '',
          revokedAt: null,
          clientAddress: null,
        },
      }),
    ).toEqual({ authRequired: true, authenticated: true, csrfToken: 'csrf' });
  });
});

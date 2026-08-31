import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '../../shared/auth.ts';
import { createDb, type Db } from '../db.ts';
import {
  createSession,
  hashSessionToken,
  lookupSession,
  lookupSessionByHash,
  purgeExpiredSessions,
  revokeAllSessions,
  revokeSession,
  sessionLiveByHash,
} from './sessions.ts';

const SECRET = 'session-secret-at-least-thirty-two-chars!!';

describe('operator sessions', () => {
  let db: Db;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // Already closed or never opened.
    }
    db = undefined as unknown as Db;
  });

  const open = () => {
    db = createDb(':memory:');
    return db;
  };

  it('createSession stores only a hash and returns a distinct CSRF token', () => {
    open();
    const first = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000_000,
    });
    const second = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000_000,
    });

    expect(first.rawToken).not.toBe(second.rawToken);
    expect(first.csrfToken).not.toBe(second.csrfToken);
    expect(first.record.csrfToken).toBe(first.csrfToken);
    expect(first.record.tokenHash).toBe(hashSessionToken(first.rawToken, SECRET));
    expect(first.rawToken).not.toBe(first.record.tokenHash);

    const stored = db
      .prepare('SELECT token_hash, csrf_token FROM operator_sessions')
      .all() as Array<{ token_hash: string; csrf_token: string }>;
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.token_hash)).not.toContain(first.rawToken);
    expect(new Set(stored.map((row) => row.csrf_token)).size).toBe(2);
  });

  it('lookupSession returns the row and extends idle expiry on touch', () => {
    open();
    const created = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '10.0.0.1',
      now: 5_000_000,
    });
    const touchedAt = 5_000_000 + 60_000;
    const found = lookupSession(db, {
      rawToken: created.rawToken,
      sessionSecret: SECRET,
      now: touchedAt,
    });
    expect(found).not.toBeNull();
    expect(found!.csrfToken).toBe(created.csrfToken);
    expect(found!.lastSeenAt).toBe(new Date(touchedAt).toISOString());
    expect(found!.idleExpiresAt).toBe(new Date(touchedAt + SESSION_IDLE_TIMEOUT_MS).toISOString());
    expect(found!.absoluteExpiresAt).toBe(created.record.absoluteExpiresAt);
  });

  it('lookupSession returns null after idle expiry', () => {
    open();
    const created = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: null,
      now: 1_000_000,
    });
    expect(
      lookupSession(db, {
        rawToken: created.rawToken,
        sessionSecret: SECRET,
        now: 1_000_000 + SESSION_IDLE_TIMEOUT_MS + 1,
      }),
    ).toBeNull();
  });

  it('lookupSession returns null after absolute expiry even if idle was refreshed', () => {
    open();
    const start = 2_000_000;
    const created = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '1.1.1.1',
      now: start,
    });
    // Touch near the absolute limit — idle would extend, but absolute has passed.
    expect(
      lookupSession(db, {
        rawToken: created.rawToken,
        sessionSecret: SECRET,
        now: start + SESSION_ABSOLUTE_TIMEOUT_MS + 1,
      }),
    ).toBeNull();
  });

  it('revokeSession and revokeAllSessions make lookup return null', () => {
    open();
    const a = createSession(db, { sessionSecret: SECRET, clientAddress: 'a', now: 0 });
    const b = createSession(db, { sessionSecret: SECRET, clientAddress: 'b', now: 0 });
    revokeSession(db, a.record.tokenHash, 100);
    expect(lookupSession(db, { rawToken: a.rawToken, sessionSecret: SECRET, now: 200 })).toBeNull();
    expect(
      lookupSession(db, { rawToken: b.rawToken, sessionSecret: SECRET, now: 200 }),
    ).not.toBeNull();

    revokeAllSessions(db, 300);
    expect(lookupSession(db, { rawToken: b.rawToken, sessionSecret: SECRET, now: 400 })).toBeNull();
  });

  it('purgeExpiredSessions deletes expired and revoked rows', () => {
    open();
    const live = createSession(db, { sessionSecret: SECRET, clientAddress: 'x', now: 10_000 });
    const idle = createSession(db, { sessionSecret: SECRET, clientAddress: 'y', now: 0 });
    revokeSession(db, live.record.tokenHash, 10_000);

    const removed = purgeExpiredSessions(db, SESSION_IDLE_TIMEOUT_MS + 1);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(
      lookupSession(db, {
        rawToken: idle.rawToken,
        sessionSecret: SECRET,
        now: SESSION_IDLE_TIMEOUT_MS + 1,
      }),
    ).toBeNull();
  });

  it('hashSessionToken is deterministic and secret-dependent', () => {
    const token = 'raw-token-value';
    expect(hashSessionToken(token, SECRET)).toBe(hashSessionToken(token, SECRET));
    expect(hashSessionToken(token, SECRET)).not.toBe(hashSessionToken(token, `${SECRET}x`));
  });

  it('lookupSessionByHash mirrors lookupSession expiry and refresh rules', () => {
    open();
    const created = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    expect(
      lookupSessionByHash(db, { tokenHash: created.record.tokenHash, now: 1_001 }),
    ).toMatchObject({ tokenHash: created.record.tokenHash });
    expect(lookupSessionByHash(db, { tokenHash: 'missing' })).toBeNull();
    revokeSession(db, created.record.tokenHash, 2_000);
    expect(lookupSessionByHash(db, { tokenHash: created.record.tokenHash, now: 2_001 })).toBeNull();
  });
  it('sessionLiveByHash reports liveness without touching the row', () => {
    db = createDb(':memory:');
    const created = createSession(db, { sessionSecret: SECRET, clientAddress: null, now: 1_000 });
    const hash = created.record.tokenHash;
    const stamps = () =>
      db
        .prepare('SELECT last_seen_at, idle_expires_at FROM operator_sessions WHERE token_hash = ?')
        .get(hash);

    expect(sessionLiveByHash(db, { tokenHash: '' })).toBe(false);
    expect(sessionLiveByHash(db, { tokenHash: 'missing' })).toBe(false);
    expect(sessionLiveByHash(db, { tokenHash: hash, now: 2_000 })).toBe(true);

    // The whole reason this exists next to lookupSessionByHash: reading liveness must not refresh
    // the idle window, or the OAuth token endpoint would let a machine call stand in for presence.
    const before = stamps();
    expect(sessionLiveByHash(db, { tokenHash: hash, now: 500_000 })).toBe(true);
    expect(stamps()).toEqual(before);

    expect(sessionLiveByHash(db, { tokenHash: hash, now: 1_000 + SESSION_IDLE_TIMEOUT_MS })).toBe(
      false,
    );

    // Absolute expiry refuses even while the idle window is still open.
    db.prepare('UPDATE operator_sessions SET absolute_expires_at = ? WHERE token_hash = ?').run(
      new Date(1_500).toISOString(),
      hash,
    );
    expect(sessionLiveByHash(db, { tokenHash: hash, now: 2_000 })).toBe(false);

    db.prepare('UPDATE operator_sessions SET absolute_expires_at = ? WHERE token_hash = ?').run(
      new Date(1_000 + SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(),
      hash,
    );
    revokeSession(db, hash, 3_000);
    expect(sessionLiveByHash(db, { tokenHash: hash, now: 4_000 })).toBe(false);
  });
});

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { getSetting, setSetting } from './service.ts';
import {
  OAUTH_STATE_SETTINGS_KEY,
  OAUTH_STATE_TTL_MS,
  OAuthStateError,
  beginAuthorization,
  consumeAuthorization,
  createGoogleOAuthClient,
  purgeExpiredAuthorizations,
  readPendingAuthorization,
} from './oauth.ts';
import { DRIVE_OAUTH_SCOPE } from '../../shared/drive-oauth.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

/** A fixed clock, so an expiry is exercised by arithmetic rather than by waiting. */
const MINTED_AT = new Date('2026-05-01T12:00:00.000Z');
const later = (ms: number) => new Date(MINTED_AT.getTime() + ms);

describe('OAuth authorization state', () => {
  it('mints a state and the S256 challenge for the verifier it stored', () => {
    const { state, challenge } = beginAuthorization(db, MINTED_AT);
    const stored = readPendingAuthorization(db, state);

    expect(stored).toMatchObject({
      state,
      issuedAt: MINTED_AT.toISOString(),
      sessionTokenHash: null,
    });
    // RFC 7636 §4.1: 32 random bytes as base64url, which is 43 characters.
    expect(stored?.verifier).toHaveLength(43);
    expect(challenge).toBe(
      crypto.createHash('sha256').update(stored!.verifier).digest('base64url'),
    );
    // The verifier is the half that must not travel with the browser.
    expect(challenge).not.toBe(stored?.verifier);
  });

  it('mints a different state and verifier every time', () => {
    const first = beginAuthorization(db, MINTED_AT);
    const firstVerifier = readPendingAuthorization(db, first.state)?.verifier;
    const second = beginAuthorization(db, MINTED_AT);

    expect(second.state).not.toBe(first.state);
    expect(readPendingAuthorization(db, second.state)?.verifier).not.toBe(firstVerifier);
  });

  it('returns the verifier and deletes the row when the state matches', () => {
    const { state } = beginAuthorization(db, MINTED_AT);
    const verifier = readPendingAuthorization(db, state)?.verifier;

    expect(consumeAuthorization(db, state, MINTED_AT).verifier).toBe(verifier);
    // Deleted, not overwritten: absence is what makes the next attempt fail.
    expect(readPendingAuthorization(db, state)).toBeUndefined();
  });

  it('rejects a replay of a state that already succeeded', () => {
    const { state } = beginAuthorization(db, MINTED_AT);
    consumeAuthorization(db, state, MINTED_AT);

    expect(() => consumeAuthorization(db, state, MINTED_AT)).toThrow(OAuthStateError);
  });

  it.each(['used', 'undefined', 'null', ''])(
    'rejects the invented state %j when nothing is pending',
    (state) => {
      expect(() => consumeAuthorization(db, state, MINTED_AT)).toThrow(OAuthStateError);
    },
  );

  it('clears the obsolete single settings oauth_state row on purge', () => {
    setSetting(db, OAUTH_STATE_SETTINGS_KEY, 'used');
    purgeExpiredAuthorizations(db, MINTED_AT);
    expect(getSetting(db, OAUTH_STATE_SETTINGS_KEY)).toBeUndefined();
  });

  it.each([[undefined], [null], [42], [['a']], [{ state: 'a' }]])(
    'rejects a non-string state %j',
    (state) => {
      beginAuthorization(db, MINTED_AT);
      expect(() => consumeAuthorization(db, state, MINTED_AT)).toThrow(OAuthStateError);
    },
  );

  it('accepts a state at the edge of the window and rejects one past it', () => {
    const first = beginAuthorization(db, MINTED_AT);
    expect(() => consumeAuthorization(db, first.state, later(OAUTH_STATE_TTL_MS))).not.toThrow();

    const second = beginAuthorization(db, MINTED_AT);
    expect(() => consumeAuthorization(db, second.state, later(OAUTH_STATE_TTL_MS + 1))).toThrow(
      OAuthStateError,
    );
  });

  it('consumes an expired state rather than leaving it to be retried', () => {
    const { state } = beginAuthorization(db, MINTED_AT);
    expect(() => consumeAuthorization(db, state, later(OAUTH_STATE_TTL_MS + 1))).toThrow();

    expect(readPendingAuthorization(db, state)).toBeUndefined();
  });

  it('rejects a state issued after the callback arrived, so a backwards clock cannot outlive the window', () => {
    const { state } = beginAuthorization(db, MINTED_AT);

    expect(() => consumeAuthorization(db, state, later(-1))).toThrow(OAuthStateError);
  });

  /**
   * A stray callback is someone else's request. Cancelling every pending authorization would
   * hand any page that can reach the callback a way to break connects still in flight, so a
   * mismatch leaves other rows alone.
   */
  it('leaves other pending authorizations in place when the state does not match', () => {
    const { state } = beginAuthorization(db, MINTED_AT);
    const stored = readPendingAuthorization(db, state);

    expect(() => consumeAuthorization(db, crypto.randomUUID(), MINTED_AT)).toThrow(OAuthStateError);
    expect(readPendingAuthorization(db, state)).toEqual(stored);
    expect(consumeAuthorization(db, state, MINTED_AT).verifier).toBe(stored?.verifier);
  });

  it('keeps independent pending authorizations for concurrent connect attempts', () => {
    const first = beginAuthorization(db, MINTED_AT, { sessionTokenHash: 'session-a' });
    const second = beginAuthorization(db, MINTED_AT, { sessionTokenHash: 'session-b' });

    expect(
      consumeAuthorization(db, first.state, MINTED_AT, { sessionTokenHash: 'session-a' }).state,
    ).toBe(first.state);
    expect(
      consumeAuthorization(db, second.state, MINTED_AT, { sessionTokenHash: 'session-b' }).state,
    ).toBe(second.state);
  });

  it('refuses to complete a state from a different session', () => {
    const { state } = beginAuthorization(db, MINTED_AT, { sessionTokenHash: 'session-a' });

    expect(() =>
      consumeAuthorization(db, state, MINTED_AT, { sessionTokenHash: 'session-b' }),
    ).toThrow(OAuthStateError);
    expect(readPendingAuthorization(db, state)?.sessionTokenHash).toBe('session-a');

    expect(() => consumeAuthorization(db, state, MINTED_AT, { sessionTokenHash: null })).toThrow(
      OAuthStateError,
    );
  });

  it('allows an unbound pending state without a session (loopback)', () => {
    const { state } = beginAuthorization(db, MINTED_AT, { sessionTokenHash: null });
    expect(consumeAuthorization(db, state, MINTED_AT, { sessionTokenHash: null }).state).toBe(
      state,
    );
  });

  it('puts drive.file on the real authorization URL without contacting Google', () => {
    const client = createGoogleOAuthClient({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:8787/api/drive/oauth/callback',
    });
    const url = client.authorizationUrl({ state: 'state', challenge: 'challenge' });
    const scopes = new URL(url).searchParams.getAll('scope').flatMap((s) => s.split(/\s+/));
    expect(scopes).toEqual([DRIVE_OAUTH_SCOPE]);
  });
});

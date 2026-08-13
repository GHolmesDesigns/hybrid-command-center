import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { getSetting, setSetting } from './service.ts';
import {
  OAUTH_STATE_KEY,
  OAUTH_STATE_TTL_MS,
  OAuthStateError,
  beginAuthorization,
  consumeAuthorization,
} from './oauth.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

/** A fixed clock, so an expiry is exercised by arithmetic rather than by waiting. */
const MINTED_AT = new Date('2026-05-01T12:00:00.000Z');
const later = (ms: number) => new Date(MINTED_AT.getTime() + ms);

/** The pending row as stored, which is the only place the verifier exists. */
const pendingRow = () => {
  const raw = getSetting(db, OAUTH_STATE_KEY);
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, string>);
};

describe('OAuth authorization state', () => {
  it('mints a state and the S256 challenge for the verifier it stored', () => {
    const { state, challenge } = beginAuthorization(db, MINTED_AT);
    const stored = pendingRow();

    expect(stored).toMatchObject({ state, issuedAt: MINTED_AT.toISOString() });
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
    const firstVerifier = pendingRow()?.verifier;
    const second = beginAuthorization(db, MINTED_AT);

    expect(second.state).not.toBe(first.state);
    expect(pendingRow()?.verifier).not.toBe(firstVerifier);
  });

  it('returns the verifier and deletes the row when the state matches', () => {
    const { state } = beginAuthorization(db, MINTED_AT);
    const verifier = pendingRow()?.verifier;

    expect(consumeAuthorization(db, state, MINTED_AT).verifier).toBe(verifier);
    // Deleted, not overwritten: absence is what makes the next attempt fail.
    expect(getSetting(db, OAUTH_STATE_KEY)).toBeUndefined();
  });

  it('rejects a replay of a state that already succeeded', () => {
    const { state } = beginAuthorization(db, MINTED_AT);
    consumeAuthorization(db, state, MINTED_AT);

    expect(() => consumeAuthorization(db, state, MINTED_AT)).toThrow(OAuthStateError);
  });

  /**
   * The sentinel bug in the shape it shipped as: the old callback wrote `used` after a
   * successful connect, so `?state=used` matched from then on.
   */
  it.each(['used', 'undefined', 'null', ''])(
    'rejects the invented state %j when nothing is pending',
    (state) => {
      expect(() => consumeAuthorization(db, state, MINTED_AT)).toThrow(OAuthStateError);
    },
  );

  it('rejects a stored value it did not write, and clears it', () => {
    // The row an older build left behind, which no callback should be able to match.
    setSetting(db, OAUTH_STATE_KEY, 'used');

    expect(() => consumeAuthorization(db, 'used', MINTED_AT)).toThrow(OAuthStateError);
    expect(getSetting(db, OAUTH_STATE_KEY)).toBeUndefined();
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

    expect(getSetting(db, OAUTH_STATE_KEY)).toBeUndefined();
  });

  it('rejects a state issued after the callback arrived, so a backwards clock cannot outlive the window', () => {
    const { state } = beginAuthorization(db, MINTED_AT);

    expect(() => consumeAuthorization(db, state, later(-1))).toThrow(OAuthStateError);
  });

  /**
   * A stray callback is someone else's request. Cancelling the pending authorization would
   * hand any page that can reach loopback a way to break the connect the user is mid-way
   * through, so a mismatch leaves the row for the browser still to come back.
   */
  it('leaves the pending authorization in place when the state does not match', () => {
    const { state } = beginAuthorization(db, MINTED_AT);
    const stored = pendingRow();

    expect(() => consumeAuthorization(db, crypto.randomUUID(), MINTED_AT)).toThrow(OAuthStateError);
    expect(pendingRow()).toEqual(stored);
    // And the real callback still works afterwards.
    expect(consumeAuthorization(db, state, MINTED_AT).verifier).toBe(stored?.verifier);
  });

  it('replaces a pending authorization when a second connect starts', () => {
    const first = beginAuthorization(db, MINTED_AT);
    const second = beginAuthorization(db, MINTED_AT);

    expect(() => consumeAuthorization(db, first.state, MINTED_AT)).toThrow(OAuthStateError);
    expect(consumeAuthorization(db, second.state, MINTED_AT).state).toBe(second.state);
  });
});

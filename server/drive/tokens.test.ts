import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from './tokens.ts';

/**
 * The only thing standing between a stolen `data/command-center.db` and a live Google
 * session. AGENTS.md says tokens are encrypted server-side and never reach the browser, so
 * what is worth proving is that the stored form is unreadable without the key and refuses
 * to decrypt once anything about it has been altered.
 */

const SECRET = 'a-long-random-local-secret-value';
const TOKENS = { access_token: 'ya29.super-secret', refresh_token: '1//refresh', expiry: 1234 };

describe('token encryption', () => {
  it('returns the same object it was given', () => {
    expect(decryptJson(encryptJson(TOKENS, SECRET), SECRET)).toEqual(TOKENS);
  });

  it('carries nested values and non-ASCII text through unchanged', () => {
    const value = { scopes: ['drive.file', 'drive.metadata'], account: { name: 'Café Noir ✓' } };
    expect(decryptJson(encryptJson(value, SECRET), SECRET)).toEqual(value);
  });

  it('leaves no plaintext in the stored value', () => {
    const stored = encryptJson(TOKENS, SECRET);
    expect(stored).not.toContain('ya29');
    expect(stored).not.toContain('refresh');
    expect(stored).not.toContain('access_token');
  });

  it('writes a different value every time, so equal tokens do not look equal at rest', () => {
    // A fresh IV per call. Without one, two clients holding the same token would be
    // visibly the same row, and GCM would be reused under one key.
    const [first, second] = [encryptJson(TOKENS, SECRET), encryptJson(TOKENS, SECRET)];
    expect(first).not.toBe(second);
    expect(decryptJson(first, SECRET)).toEqual(decryptJson(second, SECRET));
  });

  it('stores exactly the three dot-separated parts it reads back', () => {
    const parts = encryptJson(TOKENS, SECRET).split('.');
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part).not.toHaveLength(0);
    // base64url, so a value can sit in a database column or a URL without escaping.
    for (const part of parts) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses to encrypt when no key is configured', () => {
    expect(() => encryptJson(TOKENS, '')).toThrow(
      'GOOGLE_TOKEN_ENCRYPTION_KEY is required before connecting Drive.',
    );
  });

  it('will not decrypt under a different key', () => {
    const stored = encryptJson(TOKENS, SECRET);
    expect(() => decryptJson(stored, 'a-different-local-secret-value')).toThrow();
  });

  it('rejects an altered ciphertext instead of returning something wrong', () => {
    const [iv, tag, encrypted] = encryptJson(TOKENS, SECRET).split('.');
    const flipped = Buffer.from(encrypted, 'base64url');
    flipped[0] ^= 0xff;
    expect(() => decryptJson([iv, tag, flipped.toString('base64url')].join('.'), SECRET)).toThrow();
  });

  it('rejects an altered authentication tag', () => {
    const [iv, tag, encrypted] = encryptJson(TOKENS, SECRET).split('.');
    const flipped = Buffer.from(tag, 'base64url');
    flipped[0] ^= 0xff;
    expect(() =>
      decryptJson([iv, flipped.toString('base64url'), encrypted].join('.'), SECRET),
    ).toThrow();
  });

  it('rejects an altered IV', () => {
    const [iv, tag, encrypted] = encryptJson(TOKENS, SECRET).split('.');
    const flipped = Buffer.from(iv, 'base64url');
    flipped[0] ^= 0xff;
    expect(() =>
      decryptJson([flipped.toString('base64url'), tag, encrypted].join('.'), SECRET),
    ).toThrow();
  });

  it('rejects a value that is not in the stored shape at all', () => {
    expect(() => decryptJson('not-encrypted', SECRET)).toThrow();
    expect(() => decryptJson('', SECRET)).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password.ts';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password with argon2id', async () => {
    const password = 'a-strong-operator-password';
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, password)).toBe(true);
    expect(await verifyPassword(hash, 'a-strong-operator-passworx')).toBe(false);
  });

  it('refuses a blank password rather than hashing it', async () => {
    await expect(hashPassword('')).rejects.toThrow(/blank/);
    await expect(hashPassword('   ')).rejects.toThrow(/blank/);
  });

  it(`refuses a password shorter than ${MIN_PASSWORD_LENGTH} characters`, async () => {
    await expect(hashPassword('short-pass')).rejects.toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH}`),
    );
  });

  it('verifyPassword returns false for a blank password or bad hash without throwing', async () => {
    const hash = await hashPassword('a-strong-operator-password');
    expect(await verifyPassword(hash, '')).toBe(false);
    expect(await verifyPassword('', 'a-strong-operator-password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'a-strong-operator-password')).toBe(false);
  });
});

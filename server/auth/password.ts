/**
 * Operator password hashing (C51 / #177).
 *
 * Argon2id only. The plaintext is never logged — callers must not pass it to a logger either.
 */
import argon2 from 'argon2';

export const MIN_PASSWORD_LENGTH = 12;

function assertPasswordUsable(password: string): void {
  if (!password || !password.trim()) {
    throw new Error('Password must not be blank.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

/** Hash a password with argon2id. Refuses blank or short passwords. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordUsable(password);
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Verify a password against a stored argon2 hash.
 * Returns false for a blank password or an unreadable hash rather than throwing.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!password || !hash) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

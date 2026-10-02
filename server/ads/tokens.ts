/**
 * Ads token storage: the Drive cipher, under the Ads key only.
 *
 * `server/drive/tokens.ts` holds the AES-256-GCM helpers and its missing-key message names Drive,
 * so this wraps it rather than parameterizing it: the key is checked here first, with Ads' own
 * words, and a ciphertext that does not open under the key it is given — Drive's, a rotated one —
 * surfaces as one `AdsTokenError` that carries no ciphertext and no key material.
 */
import { ENCRYPTION_KEY_MIN_LENGTH } from '../config.ts';
import { decryptJson, encryptJson } from '../drive/tokens.ts';

export class AdsTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdsTokenError';
  }
}

const requireKey = (key: string) => {
  if (!key)
    throw new AdsTokenError('GOOGLE_ADS_TOKEN_ENCRYPTION_KEY is required before connecting Ads.');
  if (key.length < ENCRYPTION_KEY_MIN_LENGTH)
    throw new AdsTokenError(
      `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY must be at least ${ENCRYPTION_KEY_MIN_LENGTH} characters.`,
    );
};

export function encryptAdsRefreshToken(refreshToken: string, key: string): string {
  requireKey(key);
  if (!refreshToken) throw new AdsTokenError('There is no refresh token to store.');
  return encryptJson({ refreshToken }, key);
}

export function decryptAdsRefreshToken(ciphertext: string, key: string): string {
  requireKey(key);
  try {
    const value = decryptJson(ciphertext, key) as { refreshToken?: unknown };
    if (typeof value?.refreshToken !== 'string' || !value.refreshToken) throw new Error('shape');
    return value.refreshToken;
  } catch {
    throw new AdsTokenError(
      'The stored Google Ads credential cannot be read with the current encryption key.',
    );
  }
}

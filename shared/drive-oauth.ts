/**
 * Drive OAuth constants and redirect-URI shape shared by boot validation and docs/tests.
 *
 * The redirect is configuration, never a user-supplied return URL — validating its shape is
 * what keeps an open redirect from being introduced by a typo in `.env`.
 */

/** The only Drive scope this app requests (C52). */
export const DRIVE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * True when `value` is a localhost or 127.0.0.1 http callback, or an https callback, with the
 * fixed path `/api/drive/oauth/callback` and no query or hash.
 */
export function isAllowedGoogleRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.pathname !== '/api/drive/oauth/callback') return false;
  if (url.search !== '' || url.hash !== '') return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:') {
    return host === 'localhost' || host === '127.0.0.1';
  }
  if (url.protocol === 'https:') {
    return host.length > 0;
  }
  return false;
}

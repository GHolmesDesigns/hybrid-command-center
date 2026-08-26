/**
 * Operator authentication constants and types shared by the API and the client (C51 / #177).
 *
 * Loopback stays passwordless. A non-loopback bind requires the full §5.1 checklist in
 * `docs/cloud-hosting.md` — see `authenticationConfigured` in `server/config.ts`.
 */

/** HttpOnly session cookie name. The cookie holds the raw token; SQLite stores only a hash. */
export const SESSION_COOKIE_NAME = 'hcc_session';

/** Header the client echoes on state-changing requests; must match the session's CSRF token. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Idle timeout: no request refreshes the session after this long. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_IDLE_TIMEOUT_LABEL = '30 minutes';

/** Absolute timeout: a session cannot outlive this even with continuous activity. */
export const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_LABEL = '12 hours';

/** Failures counted against one client address before a hard lockout for the window. */
export const LOGIN_MAX_FAILURES = 5;

/** Rolling window over which login failures accumulate. */
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURE_WINDOW_LABEL = '15 minutes';

/**
 * Progressive delay base after the first failure within the window: 1s, 2s, 4s, …
 * The zeroth attempt (no prior failures) has no delay.
 */
export const LOGIN_DELAY_BASE_MS = 1000;

/** Cap on the progressive delay so a long failure streak does not grow without bound. */
export const LOGIN_DELAY_CAP_MS = 30_000;

/**
 * API path prefixes that do not require a session when auth is enforced.
 * Logout is public so an expired session can still clear the HttpOnly cookie.
 */
export const AUTH_PUBLIC_API_PREFIXES = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
] as const;

export type AuthPublicApiPrefix = (typeof AUTH_PUBLIC_API_PREFIXES)[number];

/** What `GET /api/auth/status` returns to the browser. */
export type AuthStatusResponse = {
  authRequired: boolean;
  authenticated: boolean;
  csrfToken: string | null;
};

/** True when `pathname` is a public auth prefix or a subpath of one. */
export function isAuthPublicPath(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? pathname;
  return AUTH_PUBLIC_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

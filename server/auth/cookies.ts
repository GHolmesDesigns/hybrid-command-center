/**
 * Session cookie parse / Set-Cookie helpers (C51 / #177).
 *
 * HttpOnly + SameSite=Lax + Path=/. Secure is on when the deployment terminates TLS and auth is
 * enforced — never on a plain loopback http:// origin during local development.
 */
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_COOKIE_NAME } from '../../shared/auth.ts';

/** Parse a Cookie header into name → value. Last occurrence wins for a repeated name. */
export function parseCookieHeader(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    out[name] = value;
  }
  return out;
}

export function readSessionToken(cookieHeader: string | undefined | null): string | null {
  const value = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME];
  return value || null;
}

export type SessionCookieOptions = {
  secure: boolean;
  /** Defaults to the absolute session timeout. */
  maxAgeSec?: number;
};

function baseAttributes(secure: boolean): string[] {
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts;
}

/** Set-Cookie value that establishes the operator session. */
export function buildSessionCookie(rawToken: string, options: SessionCookieOptions): string {
  const maxAgeSec = options.maxAgeSec ?? Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000);
  return [
    `${SESSION_COOKIE_NAME}=${rawToken}`,
    `Max-Age=${maxAgeSec}`,
    ...baseAttributes(options.secure),
  ].join('; ');
}

/** Set-Cookie value that clears the operator session cookie. */
export function clearSessionCookie(options: { secure: boolean }): string {
  return [`${SESSION_COOKIE_NAME}=`, 'Max-Age=0', ...baseAttributes(options.secure)].join('; ');
}

import { describe, expect, it } from 'vitest';
import {
  AUTH_PUBLIC_API_PREFIXES,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  isAuthPublicPath,
} from './auth.ts';

describe('shared/auth', () => {
  it('exports the cookie and CSRF names the server and client share', () => {
    expect(SESSION_COOKIE_NAME).toBe('hcc_session');
    expect(CSRF_HEADER_NAME).toBe('x-csrf-token');
  });

  it('recognises the public API prefixes', () => {
    expect(AUTH_PUBLIC_API_PREFIXES).toContain('/api/health');
    expect(isAuthPublicPath('/api/health')).toBe(true);
    expect(isAuthPublicPath('/api/auth/login')).toBe(true);
    expect(isAuthPublicPath('/api/auth/status')).toBe(true);
    expect(isAuthPublicPath('/api/auth/logout')).toBe(true);
    expect(isAuthPublicPath('/api/clients')).toBe(false);
  });
});

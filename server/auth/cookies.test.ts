import { describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_COOKIE_NAME } from '../../shared/auth.ts';
import {
  buildSessionCookie,
  clearSessionCookie,
  parseCookieHeader,
  readSessionToken,
} from './cookies.ts';

describe('cookie helpers', () => {
  it('parseCookieHeader splits name/value pairs and keeps the last duplicate', () => {
    expect(parseCookieHeader('a=1; b=two; a=3')).toEqual({ a: '3', b: 'two' });
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('readSessionToken pulls only the session cookie', () => {
    expect(readSessionToken(`other=1; ${SESSION_COOKIE_NAME}=tok; x=y`)).toBe('tok');
    expect(readSessionToken('other=1')).toBeNull();
  });

  it('buildSessionCookie sets HttpOnly, SameSite=Lax, Path=/, and Max-Age', () => {
    const header = buildSessionCookie('raw-token', { secure: false });
    expect(header).toContain(`${SESSION_COOKIE_NAME}=raw-token`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)}`);
    expect(header).not.toContain('Secure');
  });

  it('buildSessionCookie adds Secure when requested', () => {
    expect(buildSessionCookie('tok', { secure: true })).toContain('Secure');
  });

  it('clearSessionCookie expires the cookie immediately', () => {
    const header = clearSessionCookie({ secure: true });
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
  });
});

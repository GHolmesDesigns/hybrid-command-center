import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '../../shared/auth.ts';
import { createDb, type Db } from '../db.ts';
import { createAuthMiddleware, type AuthedRequest } from './middleware.ts';
import { createSession } from './sessions.ts';

const SECRET = 'session-secret-at-least-thirty-two-chars!!';

describe('createAuthMiddleware', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  const run = async (
    middleware: ReturnType<typeof createAuthMiddleware>,
    partial: Partial<Request> & { method?: string; url?: string },
  ) => {
    const req = {
      method: 'GET',
      url: '/api/clients',
      originalUrl: partial.url ?? '/api/clients',
      socket: { remoteAddress: '127.0.0.1' },
      ...partial,
      headers: { ...(partial.headers ?? {}) },
    } as unknown as AuthedRequest;
    const res = {
      statusCode: 200,
      body: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    const next = vi.fn() as unknown as NextFunction;
    middleware(req as Request, res as unknown as Response, next);
    return { req, res, next };
  };

  it('when auth is not required, attaches a null session and continues', async () => {
    const middleware = createAuthMiddleware({
      db,
      authRequired: false,
      sessionSecret: SECRET,
      trustedProxyHops: 0,
      secureCookies: false,
    });
    const { req, next, res } = await run(middleware, {});
    expect(next).toHaveBeenCalledOnce();
    expect(req.operatorSession).toBeNull();
    expect(res.statusCode).toBe(200);
  });

  it('allows public paths without a session when auth is required', async () => {
    const middleware = createAuthMiddleware({
      db,
      authRequired: true,
      sessionSecret: SECRET,
      trustedProxyHops: 0,
      secureCookies: false,
    });
    for (const url of ['/api/health', '/api/auth/login', '/api/auth/status']) {
      const { next, res, req } = await run(middleware, { url, method: 'GET' });
      expect(next).toHaveBeenCalled();
      expect(req.operatorSession).toBeNull();
      expect(res.statusCode).toBe(200);
      vi.mocked(next).mockClear();
    }
  });

  it('returns 401 for a protected path without a session', async () => {
    const middleware = createAuthMiddleware({
      db,
      authRequired: true,
      sessionSecret: SECRET,
      trustedProxyHops: 0,
      secureCookies: false,
    });
    const { next, res } = await run(middleware, { url: '/api/clients' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required.' });
  });

  it('allows the Drive OAuth callback without a session when auth is required (public redirect)', async () => {
    const middleware = createAuthMiddleware({
      db,
      authRequired: true,
      sessionSecret: SECRET,
      trustedProxyHops: 0,
      secureCookies: false,
      now: () => 1_001,
    });
    const { next, res } = await run(middleware, {
      method: 'GET',
      url: '/api/drive/oauth/callback?code=x',
      headers: {},
    });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it('allows an authenticated GET and attaches the session', async () => {
    const session = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    const middleware = createAuthMiddleware({
      db,
      authRequired: true,
      sessionSecret: SECRET,
      trustedProxyHops: 0,
      secureCookies: false,
      now: () => 1_001,
    });
    const { req, next } = await run(middleware, {
      url: '/api/clients',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session.rawToken}` },
    });
    expect(next).toHaveBeenCalledOnce();
    expect(req.operatorSession?.csrfToken).toBe(session.csrfToken);
  });

  it('requires a matching CSRF header on state-changing methods', async () => {
    const session = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    const middleware = createAuthMiddleware({
      db,
      authRequired: true,
      sessionSecret: SECRET,
      trustedProxyHops: 0,
      secureCookies: false,
      now: () => 1_001,
    });
    const cookie = `${SESSION_COOKIE_NAME}=${session.rawToken}`;

    const missing = await run(middleware, {
      method: 'POST',
      url: '/api/clients',
      headers: { cookie },
    });
    expect(missing.res.statusCode).toBe(403);
    expect(missing.next).not.toHaveBeenCalled();

    const wrong = await run(middleware, {
      method: 'PATCH',
      url: '/api/clients/1',
      headers: { cookie, [CSRF_HEADER_NAME]: 'nope' },
    });
    expect(wrong.res.statusCode).toBe(403);

    const ok = await run(middleware, {
      method: 'DELETE',
      url: '/api/clients/1',
      headers: { cookie, [CSRF_HEADER_NAME]: session.csrfToken },
    });
    expect(ok.next).toHaveBeenCalledOnce();
    expect(ok.res.statusCode).toBe(200);
  });

  it('does not require CSRF on GET, including the Drive OAuth callback', async () => {
    const session = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    const middleware = createAuthMiddleware({
      db,
      authRequired: true,
      sessionSecret: SECRET,
      trustedProxyHops: 0,
      secureCookies: false,
      now: () => 1_001,
    });
    const { next } = await run(middleware, {
      method: 'GET',
      url: '/api/drive/oauth/callback?code=x',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session.rawToken}` },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});

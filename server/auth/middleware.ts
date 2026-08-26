/**
 * Express middleware for operator session + CSRF (C51 / #177).
 *
 * When `authRequired` is false (loopback), every request proceeds with `req.operatorSession = null`.
 * When true, public prefixes from `shared/auth.ts` skip the session check; everything else needs a
 * live session. State-changing methods also need a matching CSRF header — except login, which is
 * public, and GET (including the Drive OAuth callback), which SameSite=Lax already covers.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db.ts';
import { CSRF_HEADER_NAME, isAuthPublicPath } from '../../shared/auth.ts';
import { clientAddress } from './client-address.ts';
import { readSessionToken } from './cookies.ts';
import { sessionFromRawToken } from './service.ts';
import type { OperatorSessionRecord } from './sessions.ts';

export type AuthedRequest = Request & {
  operatorSession: OperatorSessionRecord | null;
  operatorClientAddress?: string;
};

export type AuthMiddlewareOptions = {
  db: Db;
  authRequired: boolean;
  sessionSecret: string;
  trustedProxyHops: number;
  secureCookies: boolean;
  now?: () => number;
};

const STATE_CHANGING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function csrfHeader(req: Request): string | null {
  const raw = req.headers[CSRF_HEADER_NAME];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
  return null;
}

function requestPath(req: Request): string {
  const url = req.originalUrl || req.url || '';
  return url.split('?')[0] || '/';
}

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const now = options.now ?? (() => Date.now());

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authed = req as AuthedRequest;
    const address = clientAddress(req, options.trustedProxyHops);
    authed.operatorClientAddress = address;

    if (!options.authRequired) {
      authed.operatorSession = null;
      next();
      return;
    }

    const path = requestPath(req);
    const rawToken = readSessionToken(req.headers.cookie);
    const session = sessionFromRawToken(options.db, {
      rawToken,
      sessionSecret: options.sessionSecret,
      now: now(),
    });

    if (isAuthPublicPath(path)) {
      authed.operatorSession = session;
      next();
      return;
    }

    if (!session) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    authed.operatorSession = session;

    const method = (req.method || 'GET').toUpperCase();
    if (STATE_CHANGING.has(method) && path !== '/api/auth/login') {
      const token = csrfHeader(req);
      if (!token || token !== session.csrfToken) {
        res.status(403).json({ error: 'CSRF token missing or invalid.' });
        return;
      }
    }

    next();
  };
}

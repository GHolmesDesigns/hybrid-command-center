import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { hashPassword } from './password.ts';
import { setSetting } from '../drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from './service.ts';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '../../shared/auth.ts';
import { loginRateLimiter } from './login-rate-limit.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';

describe('operator authentication routes', () => {
  let db: Db;
  let passwordHash: string;

  beforeEach(async () => {
    loginRateLimiter.reset();
    db = createDb(':memory:');
    passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  const app = () =>
    createApp(db, {
      enforceAuth: true,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: passwordHash,
        trustedProxyHops: 0,
        secureCookies: false,
      },
    });

  it('refuses protected reads without a session', async () => {
    const res = await request(app()).get('/api/clients');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authentication required/);
  });

  it('logs in, returns a CSRF token, and allows a mutation with that token', async () => {
    const login = await request(app()).post('/api/auth/login').send({ password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.csrfToken).toBeTruthy();
    const cookie = login.headers['set-cookie']?.[0];
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);

    const muted = await request(app())
      .post('/api/clients')
      .set('Cookie', cookie!)
      .send({ name: 'Auth Client' });
    expect(muted.status).toBe(403);

    const created = await request(app())
      .post('/api/clients')
      .set('Cookie', cookie!)
      .set(CSRF_HEADER_NAME, login.body.csrfToken)
      .send({ name: 'Auth Client' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Auth Client');
  });

  it('rejects a CSRF token from another session', async () => {
    const first = await request(app()).post('/api/auth/login').send({ password: PASSWORD });
    const second = await request(app()).post('/api/auth/login').send({ password: PASSWORD });
    const cookie = first.headers['set-cookie']?.[0];

    const res = await request(app())
      .post('/api/clients')
      .set('Cookie', cookie!)
      .set(CSRF_HEADER_NAME, second.body.csrfToken)
      .send({ name: 'Cross Session' });
    expect(res.status).toBe(403);
  });

  it('logs out and refuses the old cookie', async () => {
    const login = await request(app()).post('/api/auth/login').send({ password: PASSWORD });
    const cookie = login.headers['set-cookie']?.[0];

    const logout = await request(app()).post('/api/auth/logout').set('Cookie', cookie!);
    expect(logout.status).toBe(200);

    const again = await request(app()).get('/api/clients').set('Cookie', cookie!);
    expect(again.status).toBe(401);
  });

  it('keeps health and status public', async () => {
    expect((await request(app()).get('/api/health')).status).toBe(200);
    const status = await request(app()).get('/api/auth/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ authRequired: true, authenticated: false });
  });

  it('throttles repeated failed logins without echoing the password', async () => {
    loginRateLimiter.reset();
    const first = await request(app())
      .post('/api/auth/login')
      .send({ password: 'wrong-password!!' });
    expect(first.status).toBe(401);
    expect(JSON.stringify(first.body)).not.toContain('wrong-password');

    // Progressive delay refuses the next attempt immediately rather than waiting out the backoff.
    const delayed = await request(app())
      .post('/api/auth/login')
      .send({ password: 'wrong-password!!' });
    expect(delayed.status).toBe(429);
    expect(JSON.stringify(delayed.body)).not.toContain('wrong-password');
  });

  it('ignores a spoofed X-Forwarded-For when trusted hops are 0', async () => {
    loginRateLimiter.reset();
    await request(app())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ password: 'wrong-password!!' });
    const spoofed = await request(app())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ password: 'wrong-password!!' });
    // Same socket peer, so the progressive delay from the first failure still applies.
    expect(spoofed.status).toBe(429);
  });
});

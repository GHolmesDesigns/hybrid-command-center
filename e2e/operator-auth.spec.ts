import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';
import { loginRateLimiter } from '../server/auth/login-rate-limit.ts';

const PASSWORD = 'e2e-operator-password';
const SECRET = 'e2e-session-secret-at-least-32-chars!!';

/**
 * Wave Cloud Hosting / C51: operator authentication browser flow.
 *
 * The shared e2e API stays passwordless on loopback so the rest of the suite keeps working.
 * This spec boots its own auth-enforced listener and drives it through Playwright's browser
 * cookie jar: refuse → login → mutate with CSRF → logout → refuse again. A second check
 * against the shared loopback app proves AuthGate does not show a login screen there.
 */
test('enforced session: refuse, login, mutate, logout, refuse', async ({ browser }) => {
  loginRateLimiter.reset();
  const db = createDb(':memory:');
  const passwordHash = await hashPassword(PASSWORD);
  setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);

  const app = createApp(db, {
    enforceAuth: true,
    auth: {
      sessionSecret: SECRET,
      operatorPasswordHash: passwordHash,
      trustedProxyHops: 0,
      secureCookies: false,
    },
  });

  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    db.close();
    throw new Error('Auth e2e server did not bind a port.');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();

  try {
    const refused = await page.request.get('/api/clients');
    expect(refused.status()).toBe(401);

    await page.route('**/api/auth/status', async (route) => {
      // First paint of the login UI against this ephemeral API (no Vite shell here):
      // the status route alone is enough to drive AuthGate when we later open the shared app.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authRequired: true,
          authenticated: false,
          csrfToken: null,
        }),
      });
    });

    const login = await page.request.post('/api/auth/login', {
      data: { password: PASSWORD },
    });
    expect(login.ok()).toBe(true);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    expect(csrfToken).toBeTruthy();

    const muted = await page.request.post('/api/clients', {
      data: { name: `C51 client ${Date.now()}` },
    });
    expect(muted.status()).toBe(403);

    const name = `C51 client ${Date.now()}`;
    const created = await page.request.post('/api/clients', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: { name },
    });
    expect(created.status()).toBe(201);
    expect((await created.json()).name).toBe(name);

    const logout = await page.request.post('/api/auth/logout');
    expect(logout.ok()).toBe(true);

    const after = await page.request.get('/api/clients');
    expect(after.status()).toBe(401);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
    loginRateLimiter.reset();
  }
});

test('loopback AuthGate does not show a login screen', async ({ page }) => {
  const status = await page.request.get('/api/auth/status');
  expect(status.ok()).toBe(true);
  expect(await status.json()).toMatchObject({
    authRequired: false,
    authenticated: false,
  });

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.locator('.login-screen')).toHaveCount(0);
});

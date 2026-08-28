import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { e2eApiOrigin, e2eWebOrigin } from './endpoints.ts';

const PASSWORD = 'e2e-mcp-health-panel-password';
const SECRET = 'e2e-mcp-health-panel-session-secret!!';

test('operator opens MCP health panel, runs test connection, and sees a result', async ({
  page,
}) => {
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
  if (!address || typeof address === 'string') throw new Error('MCP health server did not bind.');
  const authApiOrigin = `http://127.0.0.1:${address.port}`;

  await page.route(`${e2eApiOrigin}/api/**`, async (route) => {
    const request = route.request();
    const target = request.url().replace(e2eApiOrigin, authApiOrigin);
    const headers = { ...request.headers() };
    delete headers.host;
    const response = await route.fetch({
      url: target,
      method: request.method(),
      headers,
      postData: request.postData(),
    });
    await route.fulfill({ response });
  });

  try {
    const login = await page.request.post(`${e2eWebOrigin}/api/auth/login`, {
      data: { password: PASSWORD },
    });
    expect(login.ok()).toBe(true);

    await page.goto(`${e2eWebOrigin}/settings`);
    await expect(page.getByRole('heading', { name: 'Connection health' })).toBeVisible();
    await expect(page.getByText('No agent has connected yet')).toBeVisible();

    const testResponsePromise = page.waitForResponse((response) =>
      response.url().includes('/api/mcp/health/test'),
    );
    await page.getByRole('button', { name: 'Test connection' }).click();
    const testResponse = await testResponsePromise;
    expect(testResponse.ok()).toBe(true);
    const body = (await testResponse.json()) as { ok: boolean; lastUsedAt: string };
    expect(body.ok).toBe(true);
    expect(body.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await expect(page.getByText('Diagnostic passed')).toBeVisible();
    await expect(page.getByText(/Last tested:/)).toBeVisible();
  } finally {
    await page.unroute(`${e2eApiOrigin}/api/**`);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
  }
});

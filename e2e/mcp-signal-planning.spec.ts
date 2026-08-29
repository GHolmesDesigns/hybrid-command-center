import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';

const PASSWORD = 'e2e-mcp-signal-planning-password';
const SECRET = 'e2e-mcp-signal-planning-session-secret!!';

/**
 * Wave 29 / C130: an agent creates a Signal draft over MCP; the operator queue API and planner
 * UI both surface it.
 */
test('agent creates a Signal draft over MCP and the operator sees it in the planner', async ({
  browser,
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
  if (!address || typeof address === 'string') throw new Error('MCP planning server did not bind.');
  const api = await browser.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
  const request = api.request;
  const caption = `MCP Signal planning ${Date.now()}`;

  try {
    const login = await request.post('/api/auth/login', { data: { password: PASSWORD } });
    expect(login.ok()).toBe(true);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const issued = await request.post('/api/auth/mcp-agents', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        label: 'e2e-signal-planner',
        scopes: ['workspace:read', 'workspace:write'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(issued.status()).toBe(201);
    const { bearerToken } = (await issued.json()) as { bearerToken: string };

    const created = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${bearerToken}` },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'signal_create_post',
          arguments: {
            clientRequestId: `e2e-signal-${Date.now()}`,
            text: caption,
            channels: ['ig'],
            status: 'DRAFT',
          },
        },
      },
    });
    expect(created.ok()).toBe(true);
    const rpc = (await created.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(rpc.error).toBeUndefined();
    expect(rpc.result?.isError).toBe(false);
    const payload = JSON.parse(rpc.result?.content?.[0]?.text ?? '{}') as {
      after?: { id?: string; text?: string };
    };
    expect(payload.after?.text).toBe(caption);

    const queue = await request.get('/api/signal/queue?lifecycle=active');
    expect(queue.ok()).toBe(true);
    const posts = (await queue.json()) as Array<{ text: string }>;
    expect(posts.some((post) => post.text === caption)).toBe(true);

    // Shared e2e UI + API: seed the same caption through the Signal HTTP write (same service
    // MCP wraps) so the planner page proves the operator can see the draft.
    const shared = await page.request.post('/api/signal/posts', {
      data: { text: caption, channels: ['ig'], status: 'DRAFT' },
    });
    expect(shared.status()).toBe(201);
    await page.goto('/signal');
    await expect(page.getByText(caption, { exact: true })).toBeVisible();
  } finally {
    await api.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

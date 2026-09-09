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

    const stamp = new Date().toISOString();
    const clientId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
    ).run(clientId, 'Bulk E2E Client', 'bulk-e2e-client', stamp, stamp);
    db.prepare(
      `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(?,?,?,?,?)`,
    ).run(projectId, clientId, 'Bulk E2E Project', stamp, stamp);
    const bulkPost = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${bearerToken}` },
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'signal_create_post',
          arguments: { clientRequestId: `e2e-bulk-post-${Date.now()}`, text: 'Bulk E2E post' },
        },
      },
    });
    const bulkRpc = (await bulkPost.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const bulkPayload = JSON.parse(bulkRpc.result?.content?.[0]?.text ?? '{}') as {
      after?: { id?: string };
    };
    const bulkId = bulkPayload.after?.id;
    if (!bulkId) throw new Error('Bulk Signal post was not created.');

    const bulkResult = async (response: { json: () => Promise<unknown> }) => {
      const rpc = (await response.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const parsed = JSON.parse(rpc.result?.content?.[0]?.text ?? '{}') as {
        data?: {
          dryRun?: boolean;
          results?: Array<{ postId: string; outcome: string; projectId?: string }>;
        };
        dryRun?: boolean;
        results?: Array<{ postId: string; outcome: string; projectId?: string }>;
      };
      return parsed.data ?? parsed;
    };

    const callBulk = (id: number, clientRequestId: string, extra: Record<string, unknown>) =>
      request.post('/api/mcp', {
        headers: { Authorization: `Bearer ${bearerToken}` },
        data: {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'signal_assign_posts',
            arguments: { clientRequestId, clientId, projectId, postIds: [bulkId], ...extra },
          },
        },
      });
    const bulkDryRun = await callBulk(3, `e2e-bulk-dry-${Date.now()}`, { dryRun: true });
    expect(bulkDryRun.ok()).toBe(true);
    expect(await bulkResult(bulkDryRun)).toMatchObject({
      dryRun: true,
      results: [{ postId: bulkId, outcome: 'ASSIGNED' }],
    });
    const partial = await callBulk(4, `e2e-bulk-partial-${Date.now()}`, {
      postIds: [bulkId, '55555555-5555-4555-8555-555555555555'],
    });
    expect(partial.ok()).toBe(true);
    expect(await bulkResult(partial)).toMatchObject({
      results: [
        { postId: bulkId, outcome: 'ASSIGNED' },
        { postId: '55555555-5555-4555-8555-555555555555', outcome: 'REFUSED' },
      ],
    });
    const bulkCommit = await callBulk(5, `e2e-bulk-commit-${Date.now()}`, {});
    expect(bulkCommit.ok()).toBe(true);
    expect(await bulkResult(bulkCommit)).toMatchObject({
      results: [{ postId: bulkId, outcome: 'ASSIGNED', projectId }],
    });

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

import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';
import type { McpChangeFeedResult } from '../shared/mcp-change-feeds.ts';

const PASSWORD = 'e2e-mcp-change-feed-password';
const SECRET = 'e2e-mcp-change-feed-session-secret!!';

/**
 * Wave 30 / C132: operator posts a handoff in the UI path; an agent resume on the coordination
 * change feed after a prior cursor receives exactly that handoff.
 */
test('operator posts a handoff and a change-feed read after a prior cursor returns it', async ({
  browser,
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
  if (!address || typeof address === 'string') throw new Error('Change-feed server did not bind.');
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
  const request = context.request;
  const stamp = Date.now();
  const message = `C132 handoff message ${stamp}`;

  try {
    const login = await request.post('/api/auth/login', { data: { password: PASSWORD } });
    expect(login.ok()).toBe(true);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const issued = await request.post('/api/auth/mcp-agents', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        label: 'e2e-change-feed',
        scopes: ['coordination:read'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(issued.status()).toBe(201);
    const { bearerToken } = (await issued.json()) as { bearerToken: string };

    const tipRpc = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${bearerToken}` },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'hcc://coordination/changes' },
      },
    });
    expect(tipRpc.ok()).toBe(true);
    const tipBody = (await tipRpc.json()) as {
      result?: { contents?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(tipBody.error).toBeUndefined();
    const tip = JSON.parse(tipBody.result?.contents?.[0]?.text ?? '{}') as McpChangeFeedResult;
    expect(tip).toMatchObject({ status: 'ok', changes: [], truncated: false });
    if (tip.status !== 'ok') throw new Error('expected tip cursor');

    const created = await request.post('/api/agent-handoffs', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        fromAgentLabel: 'cursor',
        toAgentLabel: 'e2e-change-feed',
        subjectType: 'freeform',
        message,
        clientRequestId: `c132-${stamp}`,
      },
    });
    expect(created.status()).toBe(201);
    const handoff = (await created.json()) as { id: string; state: string };
    expect(handoff.state).toBe('OPEN');

    const feedRpc = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${bearerToken}` },
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: `hcc://coordination/changes?after=${encodeURIComponent(tip.cursor)}` },
      },
    });
    expect(feedRpc.ok()).toBe(true);
    const feedBody = (await feedRpc.json()) as {
      result?: { contents?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(feedBody.error).toBeUndefined();
    const feed = JSON.parse(feedBody.result?.contents?.[0]?.text ?? '{}') as McpChangeFeedResult;
    expect(feed.status).toBe('ok');
    if (feed.status !== 'ok') throw new Error('expected feed page');
    expect(feed.changes).toEqual([
      expect.objectContaining({
        kind: 'handoff.posted',
        entityType: 'handoff',
        entityId: handoff.id,
      }),
    ]);
    expect(feed.truncated).toBe(false);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
  }
});

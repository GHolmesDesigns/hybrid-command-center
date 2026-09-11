import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';

const PASSWORD = 'e2e-mention-handoff-password';
const SECRET = 'e2e-mention-handoff-session-secret!!';

/**
 * Wave 37 / C210: a confirmed @mention on a project thread creates a linked handoff; MCP claim
 * and completion update the thread message state.
 */
test('confirmed mention handoff is claimable over MCP and returns completed on the thread', async ({
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
  if (!address || typeof address === 'string') throw new Error('Mention handoff server did not bind.');
  const request = (await browser.newContext({ baseURL: `http://127.0.0.1:${address.port}` }))
    .request;
  const run = Date.now();
  const mentionBody = `@wave37-worker please handle mention ${run}`;

  try {
    const login = await request.post('/api/auth/login', { data: { password: PASSWORD } });
    expect(login.ok()).toBe(true);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const issued = await request.post('/api/auth/mcp-agents', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        label: 'wave37-worker',
        scopes: ['coordination:read', 'coordination:write'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(issued.status()).toBe(201);
    const { bearerToken } = (await issued.json()) as { bearerToken: string };

    const client = await (
      await request.post('/api/clients', {
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        data: { name: `Wave37 Client ${run}` },
      })
    ).json();
    const project = await (
      await request.post('/api/projects', {
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        data: { clientId: client.id, name: `Wave37 Project ${run}`, priority: 'HIGH' },
      })
    ).json();
    const conversation = await (
      await request.post('/api/agent-conversations', {
        headers: { [CSRF_HEADER_NAME]: csrfToken },
        data: { title: `Wave37 thread ${run}`, scope: { type: 'project', id: project.id } },
      })
    ).json();

    const posted = await request.post(`/api/agent-conversations/${conversation.id}/messages`, {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        body: mentionBody,
        confirmHandoffs: ['wave37-worker'],
        clientRequestId: `wave37-post-${run}`,
      },
    });
    expect(posted.status()).toBe(201);
    const message = (await posted.json()) as {
      linkedHandoffs: Array<{ id: string; state: string }>;
    };
    const handoffId = message.linkedHandoffs[0]?.id;
    expect(handoffId).toBeTruthy();
    expect(message.linkedHandoffs[0]?.state).toBe('OPEN');

    const callTool = (name: string, arguments_: Record<string, unknown>, id: number) =>
      request.post('/api/mcp', {
        headers: { Authorization: `Bearer ${bearerToken}` },
        data: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } },
      });

    const claim = await callTool('coordination_claim_handoff', { handoffId }, 1);
    expect(claim.ok()).toBe(true);
    const complete = await callTool(
      'coordination_complete_handoff',
      { handoffId, outcome: 'SUCCEEDED', resultSummary: 'Mention handled.' },
      2,
    );
    expect(complete.ok()).toBe(true);

    const messages = await request.get(
      `/api/agent-conversations/${conversation.id}/messages?limit=10`,
      { headers: { [CSRF_HEADER_NAME]: csrfToken } },
    );
    expect(messages.ok()).toBe(true);
    const page = (await messages.json()) as {
      items: Array<{ body: string; linkedHandoffs: Array<{ state: string }> }>;
    };
    expect(page.items[0]?.body).toBe(mentionBody);
    expect(page.items[0]?.linkedHandoffs[0]?.state).toBe('COMPLETED');

    const handoff = await request.get(`/api/agent-handoffs/${handoffId}`, {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(handoff.ok()).toBe(true);
    expect(await handoff.json()).toMatchObject({
      state: 'COMPLETED',
      sourceConversationId: conversation.id,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

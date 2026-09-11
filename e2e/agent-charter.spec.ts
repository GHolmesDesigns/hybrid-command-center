import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';
import { AGENT_PROFILE_CHARTER_MAX } from '../shared/agent-directory.ts';

const PASSWORD = 'e2e-agent-charter-password';
const SECRET = 'e2e-agent-charter-session-secret!!';

test('operator saves an agent charter and reads it over HTTP and MCP', async ({ browser }) => {
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
  if (!address || typeof address === 'string') throw new Error('Charter server did not bind.');
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
  const request = context.request;

  try {
    const login = await request.post('/api/auth/login', { data: { password: PASSWORD } });
    expect(login.ok()).toBe(true);
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const issued = await request.post('/api/auth/mcp-agents', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        label: 'e2e-charter-agent',
        scopes: ['workspace:read'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(issued.status()).toBe(201);
    const { bearerToken, credential } = (await issued.json()) as {
      bearerToken: string;
      credential: { agentId: string };
    };

    const saved = await request.patch(`/api/agents/${credential.agentId}/profile`, {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: { charter: 'Owns queue health and reports Mondays.' },
    });
    expect(saved.ok()).toBe(true);
    expect((await saved.json()) as { agent: { charter: string } }).toMatchObject({
      agent: { charter: 'Owns queue health and reports Mondays.' },
    });

    const listed = await request.get('/api/agents/directory');
    expect(listed.ok()).toBe(true);
    const listedBody = (await listed.json()) as {
      agents: Array<{ label: string; charter: string | null }>;
    };
    expect(listedBody.agents).toContainEqual(
      expect.objectContaining({
        label: 'e2e-charter-agent',
        charter: 'Owns queue health and reports Mondays.',
      }),
    );

    const mcp = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${bearerToken}` },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'agent_list_directory', arguments: {} },
      },
    });
    expect(mcp.ok()).toBe(true);
    expect(JSON.stringify(await mcp.json())).toContain('Owns queue health and reports Mondays.');

    const overLimit = await request.patch(`/api/agents/${credential.agentId}/profile`, {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: { charter: 'x'.repeat(AGENT_PROFILE_CHARTER_MAX + 1) },
    });
    expect(overLimit.status()).toBe(400);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
  }
});

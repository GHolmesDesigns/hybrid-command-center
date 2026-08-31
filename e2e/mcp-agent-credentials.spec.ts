import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';

const PASSWORD = 'e2e-agent-registry-password';
const SECRET = 'e2e-agent-registry-session-secret!!';

test('operator issues, observes, and independently revokes an MCP agent credential', async ({
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
  if (!address || typeof address === 'string')
    throw new Error('Agent registry server did not bind.');
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${address.port}` });
  const request = context.request;

  try {
    const login = await request.post('/api/auth/login', { data: { password: PASSWORD } });
    expect(login.ok()).toBe(true);
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const issued = await request.post('/api/auth/mcp-agents', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        label: 'e2e-codex',
        scopes: ['coordination:read', 'coordination:write'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(issued.status()).toBe(201);
    const body = (await issued.json()) as {
      bearerToken: string;
      credential: { id: string };
    };
    // This response is the one-time copy surface. Subsequent list responses are asserted secret-free.
    expect(body.bearerToken).toMatch(/^hcc_mcp_/);

    const pending = await request.get(`/api/mcp/health/verification/${body.credential.id}`);
    expect(pending.ok()).toBe(true);
    expect((await pending.json()) as { status: string }).toMatchObject({ status: 'pending' });

    const call = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${body.bearerToken}` },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(call.ok()).toBe(true);

    const verified = await request.get(`/api/mcp/health/verification/${body.credential.id}`);
    const verifiedBody = (await verified.json()) as { status: string };
    expect(verifiedBody).toMatchObject({ status: 'verified' });
    expect(JSON.stringify(verifiedBody)).not.toContain(body.bearerToken);

    const listed = await request.get('/api/auth/mcp-agents');
    const registry = (await listed.json()) as {
      credentials: Array<{ id: string; label: string; lastUsedAt: string | null }>;
    };
    expect(JSON.stringify(registry)).not.toContain(body.bearerToken);
    expect(registry.credentials).toEqual([
      expect.objectContaining({
        id: body.credential.id,
        label: 'e2e-codex',
        lastUsedAt: expect.any(String),
      }),
    ]);

    const revoked = await request.post(`/api/auth/mcp-credentials/${body.credential.id}/revoke`, {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
    });
    expect(revoked.ok()).toBe(true);
    const after = await request.post('/api/mcp', {
      headers: { Authorization: `Bearer ${body.bearerToken}` },
      data: { jsonrpc: '2.0', id: 2, method: 'ping' },
    });
    expect(after.status()).toBe(401);

    const revokedVerification = await request.get(
      `/api/mcp/health/verification/${body.credential.id}`,
    );
    expect((await revokedVerification.json()) as { status: string }).toMatchObject({
      status: 'revoked',
    });

    // Same label after revoke must succeed — Settings re-issue used to 500 on the unique label.
    const reissued = await request.post('/api/auth/mcp-agents', {
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      data: {
        label: 'e2e-codex',
        scopes: ['coordination:read', 'coordination:write'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(reissued.status()).toBe(201);
    const reissueBody = (await reissued.json()) as { bearerToken: string };
    expect(reissueBody.bearerToken).toMatch(/^hcc_mcp_/);
    expect(reissueBody.bearerToken).not.toBe(body.bearerToken);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
  }
});

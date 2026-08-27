import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { hashPassword } from '../server/auth/password.ts';
import { setSetting, getSetting } from '../server/drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../server/auth/service.ts';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';
import { loginRateLimiter } from '../server/auth/login-rate-limit.ts';
import { MockOAuthClient } from '../server/drive/mock-provider.ts';
import {
  backupDatabase,
  defaultBackupDir,
  inspectDatabase,
  restoreDatabase,
} from '../server/backup.ts';
import {
  cutoverVerificationPassed,
  verifyPostRestore,
} from '../server/domain/cutover-rehearsal.ts';

const PASSWORD = 'e2e-cutover-operator-password';
const SECRET = 'e2e-cutover-session-secret-at-least-32!!';
const OAUTH_CODE = '4/0AeanS0b-cutover-authorization-code';
const MINTED_AT = new Date('2026-05-01T12:00:00.000Z');

const CREDENTIALS = {
  clientId: 'e2e-cutover-client-id',
  clientSecret: 'e2e-cutover-client-secret',
  redirectUri: 'http://127.0.0.1:8787/api/drive/oauth/callback',
  encryptionKey: 'e2e-cutover-encryption-key-32-chars!!',
  apiKey: 'e2e-cutover-api-key',
  appId: 'e2e-cutover-app-id',
};

const WORK_ROOT = path.resolve(process.cwd(), 'data/e2e-cutover-rehearsal');

function resetWorkDir() {
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });
}

async function startAuthServer(databasePath: string) {
  const passwordHash = await hashPassword(PASSWORD);
  const db = createDb(databasePath);
  setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);

  const oauth = new MockOAuthClient();
  const app = createApp(db, {
    enforceAuth: true,
    auth: {
      sessionSecret: SECRET,
      operatorPasswordHash: passwordHash,
      trustedProxyHops: 0,
      secureCookies: false,
    },
    oauth: () => oauth,
    now: () => MINTED_AT,
  });

  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    db.close();
    throw new Error('Cutover e2e server did not bind a port.');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return { app, server, db, oauth, origin };
}

async function stopAuthServer(server: Server, db: ReturnType<typeof createDb>) {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
  db.close();
}

async function login(origin: string, password: string) {
  const loginResponse = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  expect(loginResponse.ok).toBe(true);
  const body = (await loginResponse.json()) as { csrfToken: string };
  const cookie = loginResponse.headers.get('set-cookie') ?? '';
  return { csrfToken: body.csrfToken, cookie };
}

/**
 * C55 — disposable cutover rehearsal exercised end to end without production data.
 *
 * Covers login, authenticated workspace use, Drive mock reconnect, restart persistence,
 * backup, frozen-write rollback, and post-restore verification on a throwaway database.
 */
test('cloud cutover rehearsal on disposable infrastructure', async () => {
  loginRateLimiter.reset();
  resetWorkDir();

  const originalGoogle = { ...config.google };
  Object.assign(config.google, CREDENTIALS);

  const databasePath = path.join(WORK_ROOT, 'command-center.db');
  const backupDir = defaultBackupDir(databasePath);

  let handle: Awaited<ReturnType<typeof startAuthServer>> | undefined =
    await startAuthServer(databasePath);
  const { origin, oauth } = handle;

  try {
    const refused = await fetch(`${origin}/api/clients`);
    expect(refused.status).toBe(401);

    const auth = await login(origin, PASSWORD);

    const clientName = `Cutover client ${Date.now()}`;
    const created = await fetch(`${origin}/api/clients`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: auth.cookie,
        [CSRF_HEADER_NAME]: auth.csrfToken,
      },
      body: JSON.stringify({ name: clientName }),
    });
    expect(created.status).toBe(201);

    const startOAuth = await fetch(`${origin}/api/drive/oauth/start`, {
      headers: { cookie: auth.cookie },
    });
    expect(startOAuth.ok).toBe(true);
    const { url } = (await startOAuth.json()) as { url: string };
    const state = String(new URL(url).searchParams.get('state'));

    const callback = await fetch(
      `${origin}/api/drive/oauth/callback?${new URLSearchParams({ state, code: OAUTH_CODE })}`,
      { redirect: 'manual', headers: { cookie: auth.cookie } },
    );
    expect(callback.status).toBe(302);
    expect(getSetting(handle.db, 'google_tokens')).toBeDefined();
    expect(oauth.exchanges).toHaveLength(1);

    const disconnected = await fetch(`${origin}/api/settings/drive/disconnect`, {
      method: 'POST',
      headers: { cookie: auth.cookie, [CSRF_HEADER_NAME]: auth.csrfToken },
    });
    expect(disconnected.ok).toBe(true);
    expect(getSetting(handle.db, 'google_tokens')).toBeUndefined();

    const reconnectStart = await fetch(`${origin}/api/drive/oauth/start`, {
      headers: { cookie: auth.cookie },
    });
    expect(reconnectStart.ok).toBe(true);
    const reconnectState = String(
      new URL((await reconnectStart.json()).url).searchParams.get('state'),
    );
    const reconnectCallback = await fetch(
      `${origin}/api/drive/oauth/callback?${new URLSearchParams({ state: reconnectState, code: OAUTH_CODE })}`,
      { redirect: 'manual', headers: { cookie: auth.cookie } },
    );
    expect(reconnectCallback.status).toBe(302);
    expect(getSetting(handle.db, 'google_tokens')).toBeDefined();

    const beforeBackup = inspectDatabase(databasePath);
    const backup = await backupDatabase({ sourcePath: databasePath, backupDir });

    const postCutoverName = `Post-cutover ${Date.now()}`;
    const postCutover = await fetch(`${origin}/api/clients`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: auth.cookie,
        [CSRF_HEADER_NAME]: auth.csrfToken,
      },
      body: JSON.stringify({ name: postCutoverName }),
    });
    expect(postCutover.status).toBe(201);

    await stopAuthServer(handle.server, handle.db);
    handle = undefined;

    await restoreDatabase({
      backupPath: backup.backupPath,
      destinationPath: databasePath,
      force: true,
      safetyBackupDir: backupDir,
    });

    const afterRestore = inspectDatabase(databasePath);
    const verification = verifyPostRestore(
      {
        clients: beforeBackup.clients,
        projects: beforeBackup.projects,
        tasks: beforeBackup.tasks,
        integrityOk: beforeBackup.integrityOk,
        foreignKeysOk: beforeBackup.foreignKeysOk,
        hasEncryptedDriveTokens: beforeBackup.hasEncryptedDriveTokens,
        driveReferenceCount: beforeBackup.driveReferences.length,
      },
      {
        clients: afterRestore.clients,
        projects: afterRestore.projects,
        tasks: afterRestore.tasks,
        integrityOk: afterRestore.integrityOk,
        foreignKeysOk: afterRestore.foreignKeysOk,
        hasEncryptedDriveTokens: afterRestore.hasEncryptedDriveTokens,
        driveReferenceCount: afterRestore.driveReferences.length,
      },
    );
    expect(cutoverVerificationPassed(verification)).toBe(true);

    handle = await startAuthServer(databasePath);

    const reloginAttempt = await fetch(`${handle.origin}/api/clients`, {
      headers: { cookie: auth.cookie },
    });
    expect(reloginAttempt.status).toBe(401);

    const afterRestart = await fetch(`${handle.origin}/api/clients`, {
      headers: { cookie: (await login(handle.origin, PASSWORD)).cookie },
    });
    expect(afterRestart.ok).toBe(true);
    const clients = (await afterRestart.json()) as { name: string }[];
    expect(clients.some((client) => client.name === clientName)).toBe(true);
    expect(clients.some((client) => client.name === postCutoverName)).toBe(false);
  } finally {
    Object.assign(config.google, originalGoogle);
    if (handle) await stopAuthServer(handle.server, handle.db);
    loginRateLimiter.reset();
    fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  }
});

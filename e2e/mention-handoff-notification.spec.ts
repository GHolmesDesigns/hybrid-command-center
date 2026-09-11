import { expect, test } from '@playwright/test';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createDb } from '../server/db.ts';
import { e2eWebOrigin } from './endpoints.ts';

/**
 * Wave 38 / C218: a confirmed @mention handoff creates an in-app notification for the recipient
 * with a working deep link into the handoff inbox.
 */
test('confirmed mention handoff notifies the recipient in the Agents panel', async ({
  browser,
  page,
}) => {
  const db = createDb(':memory:');
  db.prepare(
    `INSERT INTO agent_registrations(id,display_label,created_at,last_used_at,last_origin)
     VALUES(?,?,?,?,?)`,
  ).run('worker-id', 'wave38-worker', '2026-01-01T00:00:00.000Z', null, null);
  const app = createApp(db);
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Mention notification server did not bind.');
  }
  const isolatedOrigin = `http://127.0.0.1:${address.port}`;
  const request = (await browser.newContext({ baseURL: isolatedOrigin })).request;
  const run = Date.now();
  const mentionBody = `@wave38-worker please handle mention notification ${run}`;

  try {
    const client = await (
      await request.post('/api/clients', { data: { name: `Wave38 Client ${run}` } })
    ).json();
    const project = await (
      await request.post('/api/projects', {
        data: { clientId: client.id, name: `Wave38 Project ${run}`, priority: 'HIGH' },
      })
    ).json();
    const conversation = await (
      await request.post('/api/agent-conversations', {
        data: { title: `Wave38 thread ${run}`, scope: { type: 'project', id: project.id } },
      })
    ).json();

    const posted = await request.post(`/api/agent-conversations/${conversation.id}/messages`, {
      data: {
        body: mentionBody,
        confirmHandoffs: ['wave38-worker'],
        clientRequestId: `wave38-notify-${run}`,
      },
    });
    expect(posted.status()).toBe(201);
    const message = (await posted.json()) as {
      linkedHandoffs: Array<{ id: string; toAgentLabel: string }>;
    };
    const handoffId = message.linkedHandoffs[0]?.id;
    expect(handoffId).toBeTruthy();

    const notifications = await request.get('/api/agent-notifications?unreadOnly=true');
    expect(notifications.ok()).toBe(true);
    const pageBody = (await notifications.json()) as {
      unreadCount: number;
      notifications: Array<{
        kind: string;
        agentLabel: string;
        title: string;
        destination: { type: string; id: string } | null;
      }>;
    };
    expect(pageBody.unreadCount).toBe(1);
    expect(pageBody.notifications[0]).toMatchObject({
      kind: 'mention_handoff',
      agentLabel: 'wave38-worker',
      title: 'New handoff for you',
      destination: { type: 'handoff', id: handoffId },
    });

    const replay = await request.post(`/api/agent-conversations/${conversation.id}/messages`, {
      data: {
        body: mentionBody,
        confirmHandoffs: ['wave38-worker'],
        clientRequestId: `wave38-notify-${run}`,
      },
    });
    expect(replay.status()).toBe(201);
    const afterReplay = await request.get('/api/agent-notifications?unreadOnly=true');
    expect(((await afterReplay.json()) as { unreadCount: number }).unreadCount).toBe(1);

    const proxyToIsolated = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
      const url = new URL(route.request().url());
      const proxyUrl = `${isolatedOrigin}${url.pathname}${url.search}`;
      const headers = route.request().headers();
      const postData = route.request().postDataBuffer();
      const fetchResponse = await globalThis.fetch(proxyUrl, {
        method: route.request().method(),
        headers,
        body: postData ?? undefined,
      });
      await route.fulfill({
        status: fetchResponse.status,
        headers: Object.fromEntries(fetchResponse.headers.entries()),
        body: Buffer.from(await fetchResponse.arrayBuffer()),
      });
    };
    await page.route('**/api/agent-notifications**', proxyToIsolated);
    await page.route('**/api/agent-handoffs**', proxyToIsolated);
    await page.goto(`${e2eWebOrigin}/agents#agent-notifications`);
    await expect(page.getByRole('heading', { level: 2, name: 'Notifications' })).toBeVisible();
    await expect(page.getByText('New handoff for you')).toBeVisible();
    await expect(page.getByText('mention_handoff')).toBeVisible();
    await expect(page.getByText('wave38-worker').first()).toBeVisible();
    await page.getByRole('link', { name: 'Open destination' }).click();
    await expect(page).toHaveURL(new RegExp(`/agents\\?handoff=${handoffId}#agent-handoffs`));
    await expect(page.getByRole('region', { name: 'Handoff detail' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Handoff detail' })).toContainText(mentionBody);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

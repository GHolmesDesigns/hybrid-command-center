import { expect, test } from '@playwright/test';

test('an agent publish request waits in the operator queue until approval', async ({ page }) => {
  const text = `Agent approval ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['x'],
      date: '2099-09-17',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  const pending = await page.request.post(
    `/api/signal/posts/${postId}/publish-confirmation/preview`,
    {
      data: {
        agentLabel: 'e2e-content-agent',
        clientRequestId: `e2e-publish-${Date.now()}`,
        timing: 'scheduled',
      },
    },
  );
  expect(pending.ok()).toBe(true);
  expect((await pending.json()).status).toBe('PENDING');
  expect(await (await page.request.get(`/api/signal/posts/${postId}/publications`)).json()).toEqual(
    [],
  );

  await page.goto('/agents');
  const queue = page.getByRole('region', { name: 'Publish confirmations' });
  await expect(queue).toContainText('Requested by e2e-content-agent');
  await queue.getByRole('button', { name: 'Approve' }).click();
  await expect(queue).toContainText('Queue: 0 pending');
  await expect(queue).toContainText('Terminal state: APPROVED');

  const publications = await page.request.get(`/api/signal/posts/${postId}/publications`);
  expect(publications.ok()).toBe(true);
  expect(await publications.json()).toHaveLength(1);
});

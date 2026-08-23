import { expect, test } from '@playwright/test';

/**
 * Wave 15: Buffer account metadata reaches publishing preview only when a person asks for it.
 *
 * Opening the planner spends no Buffer request. A publish preview reads the mocked Buffer
 * channels, stores them, and records one integration event — the flow this card owns.
 */
test('publish preview refreshes Buffer accounts and an ordinary page load does not', async ({
  page,
}) => {
  const activity = await page.request.get('/api/integrations/activity?limit=50');
  expect(
    ((await activity.json()) as { operation: string }[]).filter(
      (event) => event.operation === 'signal.buffer-accounts-refresh',
    ),
  ).toHaveLength(0);

  await page.goto('/signal?month=2099-09');
  await expect(page.getByRole('region', { name: '2099-09' })).toBeVisible();

  const afterLoad = await page.request.get('/api/integrations/activity?limit=50');
  expect(
    ((await afterLoad.json()) as { operation: string }[]).filter(
      (event) => event.operation === 'signal.buffer-accounts-refresh',
    ),
  ).toHaveLength(0);

  const created = await page.request.post('/api/signal/posts', {
    data: {
      text: `Wave 15 Buffer ${Date.now()}`,
      channels: ['tt', 'yt'],
      date: '2099-09-17',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  const preview = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  expect(preview.ok()).toBe(true);
  const body = await preview.json();
  expect(body.connectedAccounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ provider: 'buffer', platform: 'tiktok', handle: '@e2e-tiktok' }),
      expect.objectContaining({ provider: 'buffer', platform: 'youtube', handle: '@e2e-youtube' }),
    ]),
  );

  const stored = await page.request.get('/api/signal/buffer-accounts');
  expect((await stored.json()).channels).toHaveLength(2);

  const afterPreview = await page.request.get('/api/integrations/activity?limit=50');
  const refreshes = (
    (await afterPreview.json()) as { operation: string; outcome: string }[]
  ).filter((event) => event.operation === 'signal.buffer-accounts-refresh');
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]?.outcome).toBe('SUCCESS');
});

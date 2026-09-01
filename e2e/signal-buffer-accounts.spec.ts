import { expect, test } from '@playwright/test';

/**
 * C156: Buffer account metadata remains readable, but is not a current TikTok/YouTube route.
 *
 * Opening the planner spends no Buffer request. A publish preview reads the mocked Buffer
 * channels, stores them, and records one integration event — the flow this card owns.
 */
test('publish preview refreshes historical Buffer accounts and an ordinary page load does not', async ({
  page,
}) => {
  const countRefreshes = async () => {
    const activity = await page.request.get('/api/integrations/activity?limit=50');
    return ((await activity.json()) as { operation: string }[]).filter(
      (event) => event.operation === 'signal.buffer-accounts-refresh',
    ).length;
  };

  const before = await countRefreshes();

  await page.goto('/signal?month=2099-09');
  await expect(page.getByRole('heading', { level: 2, name: 'September 2099' })).toBeVisible({
    timeout: 15_000,
  });

  expect(await countRefreshes()).toBe(before);

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
      expect.objectContaining({ provider: 'post-bridge', platform: 'tiktok', handle: '@gholmes' }),
      expect.objectContaining({
        provider: 'post-bridge',
        platform: 'youtube',
        handle: '@gholmesdesigns',
      }),
    ]),
  );
  expect(body.connectedAccounts).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ provider: 'buffer' })]),
  );

  const stored = await page.request.get('/api/signal/buffer-accounts');
  expect((await stored.json()).channels).toHaveLength(2);

  const afterPreview = await countRefreshes();
  expect(afterPreview).toBe(before + 1);

  const activity = await page.request.get('/api/integrations/activity?limit=50');
  const refreshes = ((await activity.json()) as { operation: string; outcome: string }[]).filter(
    (event) => event.operation === 'signal.buffer-accounts-refresh',
  );
  expect(refreshes[0]?.outcome).toBe('SUCCESS');
});

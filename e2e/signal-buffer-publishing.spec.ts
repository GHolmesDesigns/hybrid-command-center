import { expect, test } from '@playwright/test';

/** C156: TikTok and YouTube resolve to Post Bridge, never Buffer. */
test('TikTok and YouTube use the current Post Bridge route', async ({ page }) => {
  const text = `C156 Post Bridge routing ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['tt', 'yt'],
      mediaUrls: ['https://cdn.example.com/c156-video.mp4'],
      date: '2099-10-18',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const createdPost = (await created.json()) as { id: string; revision: number };
  const postId = createdPost.id;

  const firstPreview = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  const previewBody = await firstPreview.json();
  const listed = previewBody.connectedAccounts as {
    id: number;
    provider: string;
    platform: string;
  }[];
  const tiktok = listed.find(
    (target) => target.provider === 'post-bridge' && target.platform === 'tiktok',
  );
  const youtube = listed.find(
    (target) => target.provider === 'post-bridge' && target.platform === 'youtube',
  );
  expect(tiktok).toBeTruthy();
  expect(youtube).toBeTruthy();
  expect(
    listed.filter((target) => target.platform === 'tiktok' || target.platform === 'youtube'),
  ).toHaveLength(2);

  const selected = await page.request.put(`/api/signal/posts/${postId}/publish-targets`, {
    data: {
      revision: createdPost.revision,
      targets: [
        { channel: 'tt', providerAccountIds: [tiktok?.id] },
        { channel: 'yt', providerAccountIds: [youtube?.id] },
      ],
    },
  });
  expect(selected.ok()).toBe(true);
  const previewResponse = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  const preview = await previewResponse.json();
  const submittedResponse = await page.request.post(`/api/signal/posts/${postId}/publish`, {
    data: { planHash: preview.planHash },
  });
  expect(submittedResponse.ok()).toBe(true);
  const submitted = await submittedResponse.json();
  expect(submitted.provider).toBe('post-bridge');
  expect(submitted.targets).toHaveLength(2);
  expect(
    submitted.targets.every((target: { provider?: string }) => target.provider === 'post-bridge'),
  ).toBe(true);

  const signal = await page.request.get(`/api/signal/posts/${postId}`);
  expect(await signal.json()).toMatchObject({
    id: postId,
    text,
    date: '2099-10-18',
    time: '09:00',
    status: 'SCHEDULED',
  });

  await page.goto('/signal?month=2099-10');
  await page
    .getByRole('region', { name: '2099-10-18' })
    .getByRole('button', { name: `Edit ${text}` })
    .click();
  const delivery = page.getByRole('dialog').getByRole('region', { name: 'Delivery' });
  await expect(delivery).toContainText('TikTok');
  await expect(delivery).toContainText('YouTube');
  await expect(delivery).toContainText('Automatic publishing');
  await expect(page.getByRole('dialog').getByLabel('Planning status')).toHaveValue('SCHEDULED');
});

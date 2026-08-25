import { expect, test } from '@playwright/test';

test('a scheduled Signal post is previewed and explicitly confirmed before immediate publish', async ({
  page,
}) => {
  const text = `Publish now ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['x', 'blog'],
      date: '2099-09-15',
      time: '10:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id;

  await page.goto('/signal?month=2099-09');
  const post = page
    .getByRole('region', { name: '2099-09-15' })
    .locator('.signal-post')
    .filter({ hasText: text });
  await post.getByRole('button', { name: `Edit ${text}` }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Publish now' }).click();
  const preview = editor.getByRole('region', { name: 'Publish now confirmation' });
  await expect(preview).toContainText('No scheduled instant');
  await expect(preview).toContainText('irreversible');
  await expect(preview).toContainText('X → @gholmes · Ready to send');

  const before = await page.request.get(`/api/signal/posts/${postId}/publications`);
  expect(await before.json()).toEqual([]);
  await preview.getByRole('button', { name: 'Confirm publish now' }).click();
  await expect(editor.getByRole('region', { name: 'Delivery' })).toContainText(
    'Accepted, not out yet',
  );
  await expect(editor.getByLabel('Planning status')).toHaveValue('SCHEDULED');
});

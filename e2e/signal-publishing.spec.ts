import { expect, test } from '@playwright/test';

test('a scheduled Signal post is previewed and explicitly confirmed before submission', async ({
  page,
}) => {
  const text = `Wave 4 publishing ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: { text, channels: ['x'], date: '2099-09-14', time: '09:00', status: 'SCHEDULED' },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/signal?month=2099-09');
  const post = page
    .getByRole('region', { name: '2099-09-14' })
    .locator('.signal-post')
    .filter({ hasText: text });
  await post.getByRole('button', { name: `Edit ${text}` }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Preview publishing' }).click();
  const preview = editor.getByRole('region', { name: 'Publish confirmation' });
  await expect(preview).toContainText('America/New_York');
  await expect(preview).toContainText('2099-09-14T13:00:00.000Z');
  await expect(preview).toContainText('X → @gholmes');

  // Nothing has been submitted while the preview is merely open.
  const before = await page.request.get(
    `/api/signal/posts/${(await created.json()).id}/publications`,
  );
  expect(await before.json()).toEqual([]);
  await preview.getByRole('button', { name: 'Confirm and submit' }).click();
  await expect(editor.getByRole('region', { name: 'Publishing history' })).toContainText(
    'SUBMITTED',
  );
  await expect(editor.getByLabel('Status')).toHaveValue('SCHEDULED');
});

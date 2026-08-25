import { expect, test } from '@playwright/test';

/**
 * Wave 19 (C103): opt-in public media previews after Show preview.
 *
 * Assertions watch whether the page attaches an `img` or `video` `src` to a fixture hostname —
 * nothing here contacts a real media host, and a failed browser load is fine. Signed addresses
 * must stay text even after the opt-in. Drive text-only behaviour is covered in the component
 * fixtures; mixing Drive with public URLs refuses the publish plan, so it is not exercised here.
 */

test('public media stays text until Show public media previews', async ({ page }) => {
  const text = `Wave 19 public media ${Date.now()}`;
  const image = 'https://cdn.example.com/wave-19-preview.jpg';
  const video = 'https://cdn.example.com/wave-19-preview.mp4';
  const signed = 'https://cdn.example.com/wave-19-signed.jpg?token=1';
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['x'],
      mediaUrls: [image, video, signed],
      date: '2099-12-02',
      time: '09:00',
      format: 'VIDEO',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/signal?month=2099-12');
  await page
    .getByRole('region', { name: '2099-12-02' })
    .getByRole('button', { name: `Edit ${text}` })
    .click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Show preview' }).click();
  const panel = editor.getByRole('region', { name: 'Publish confirmation' }).getByRole('tabpanel');

  await expect(panel).toContainText('shares your IP address with it');
  await expect(panel.getByRole('button', { name: 'Show public media previews' })).toBeVisible();
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(panel.locator('video')).toHaveCount(0);
  await expect(panel).toContainText('signed or time-bounded');

  await panel.getByRole('button', { name: 'Show public media previews' }).click();
  await expect(panel.locator(`img[src="${image}"]`)).toHaveCount(1);
  await expect(panel.locator(`img[src="${signed}"]`)).toHaveCount(0);
  await expect(panel.locator('video')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Load this video' })).toBeVisible();

  await panel.getByRole('button', { name: 'Load this video' }).click();
  await expect(panel.locator(`video[src="${video}"]`)).toHaveCount(1);

  await panel.getByRole('button', { name: 'Show text only' }).click();
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(panel.locator('video')).toHaveCount(0);
});

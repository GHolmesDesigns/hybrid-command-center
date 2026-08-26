import { expect, test } from '@playwright/test';

/**
 * Wave 21 / C107: Retire plan is local lifecycle, not a fourth planning status and not withdraw.
 */
test('retiring a plan hides it from the active planner without changing planning status', async ({
  page,
}) => {
  const text = `Wave 21 retire ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['x'],
      date: '2099-11-18',
      time: '10:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const post = await created.json();

  await page.goto('/signal?month=2099-11');
  const cell = page.getByRole('region', { name: '2099-11-18' });
  await expect(cell.locator('.signal-post').filter({ hasText: text })).toBeVisible();

  await cell.getByRole('button', { name: `Edit ${text}` }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByLabel('Planning status')).toHaveValue('SCHEDULED');
  await expect(editor.getByLabel('Delivery provenance')).toHaveValue('IN_SIGNAL');

  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Retire plan' }).click();

  await expect(cell.locator('.signal-post').filter({ hasText: text })).toHaveCount(0);

  const reread = await page.request.get(`/api/signal/posts/${post.id}`);
  expect(reread.ok()).toBe(true);
  const body = await reread.json();
  expect(body.status).toBe('SCHEDULED');
  expect(body.lifecycle).toBe('RETIRED');

  await page.getByRole('button', { name: 'Retired', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '2099-11-18' })
      .locator('.signal-post')
      .filter({ hasText: text }),
  ).toBeVisible();
});

import { expect, test } from '@playwright/test';

/**
 * Wave 8: a problem surfacing without anybody going to look for it.
 *
 * The card's claim is that a post about to miss its slot is invisible until someone opens it, so this
 * walks the path that makes it visible: the alert appears above the planner, its name opens the post
 * it is about, and acknowledging it changes nothing but the alert. The rules themselves are covered
 * against fixtures in `shared/queue-health.test.ts`; what only a browser can prove is the link and the
 * write.
 *
 * Specs share one database, so every locator here is scoped to the post this spec created.
 */
test('a slot about to pass is reported above the planner, links to its post, and acknowledges without changing it', async ({
  page,
}) => {
  const text = `Wave 8 queue health ${Date.now()}`;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  // Today, at the top of the day: inside the approaching window whatever time the suite runs at.
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const created = await page.request.post('/api/signal/posts', {
    data: { text, channels: ['x'], date: today, time: '00:00', status: 'SCHEDULED' },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  await page.goto('/signal');
  const health = page.getByRole('region', { name: 'What needs attention' });
  const alert = health.locator('.signal-health-alert').filter({ hasText: text });

  // The alert states its level in words, not in colour alone, and names what kind of thing it is.
  await expect(alert).toContainText('Needs action');
  await expect(alert).toContainText('Scheduled slot');
  await expect(alert).toContainText('no submission is with the provider');

  // Its name is the link, and the link opens the post itself.
  await alert.getByRole('link', { name: text }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByLabel('Content')).toHaveValue(text);
  await expect(page).toHaveURL(new RegExp(`post=${postId}`));
  await editor.getByRole('button', { name: 'Close editor' }).click();
  await expect(page).not.toHaveURL(/post=/);

  // Acknowledging moves the line out of the live list and nowhere else.
  await alert.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(alert).toHaveCount(0);
  await health.getByRole('button', { name: /acknowledged$/ }).click();
  await expect(health.locator('.signal-health-alert').filter({ hasText: text })).toContainText(
    'Acknowledged',
  );

  // The plan is exactly as it was, and nothing was sent anywhere.
  const reread = await page.request.get(`/api/signal/posts/${postId}`);
  expect(await reread.json()).toMatchObject({ status: 'SCHEDULED', date: today, time: '00:00' });
  const publications = await page.request.get(`/api/signal/posts/${postId}/publications`);
  expect(await publications.json()).toEqual([]);
});

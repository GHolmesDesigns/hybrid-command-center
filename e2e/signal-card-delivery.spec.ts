import { expect, test } from '@playwright/test';

/**
 * Wave 17: delivery status visible on the planner card without opening the post.
 *
 * The card's claim is that planning status alone made a confirmed or failed delivery look merely
 * scheduled. This walks submit → card shows the delivery answer → planning status stays put, and
 * proves the planner load used the batch route rather than one publications request per card.
 */
test('planner cards show delivery beside planning from one local batch read', async ({ page }) => {
  const text = `Wave 17 card delivery ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['x'],
      date: '2099-11-12',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  const deliveryReads: string[] = [];
  const publicationReads: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/signal/card-delivery?')) deliveryReads.push(url);
    if (url.includes('/publications')) publicationReads.push(url);
  });

  await page.goto('/signal?month=2099-11');
  const card = page
    .getByRole('region', { name: '2099-11-12' })
    .locator('.signal-post')
    .filter({ hasText: text })
    .getByRole('button', { name: `Edit ${text}` });

  // Before anything is sent, the card names both facts.
  await expect(card).toContainText('Scheduled');
  await expect(card).toContainText('Not submitted');
  expect(deliveryReads.length).toBeGreaterThanOrEqual(1);
  expect(publicationReads).toHaveLength(0);

  await card.click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Show preview' }).click();
  await editor
    .getByRole('region', { name: 'Publish confirmation' })
    .getByRole('button', { name: 'Confirm and submit' })
    .click();
  await expect(editor.getByRole('region', { name: 'Delivery' })).toContainText(
    'Accepted, not out yet',
  );
  await editor.getByRole('button', { name: 'Close editor' }).click();

  // After submit, the card picks up the in-flight delivery without collapsing into planning status.
  await expect(card).toContainText('Scheduled');
  await expect(card).toContainText('In progress');

  const reread = await page.request.get(`/api/signal/posts/${postId}`);
  expect((await reread.json()).status).toBe('SCHEDULED');
});

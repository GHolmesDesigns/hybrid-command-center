import { expect, test } from '@playwright/test';

/**
 * Wave 8's milestone flow: planning status and delivery, side by side and separate.
 *
 * The whole card is the claim that one word could not carry both facts, so this walks the one
 * path where they could have been confused — a submission that the provider accepts, beside a
 * channel it never reaches — and checks that the post's own status is untouched by either.
 */
test('delivery is reported per target beside a planning status the provider never writes', async ({
  page,
}) => {
  const text = `Wave 8 delivery ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    // `blog` rides along because a channel with no provider is a delivery answer too, and the
    // section has to say so rather than leave it out.
    data: {
      text,
      channels: ['x', 'blog'],
      date: '2099-10-12',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/signal?month=2099-10');
  const post = page
    .getByRole('region', { name: '2099-10-12' })
    .locator('.signal-post')
    .filter({ hasText: text });
  await post.getByRole('button', { name: `Edit ${text}` }).click();
  const editor = page.getByRole('dialog');

  // Before anything is sent, the only delivery answer is the channel nothing reaches.
  const delivery = editor.getByRole('region', { name: 'Delivery' });
  await expect(delivery).toContainText('Unsupported');
  await expect(delivery).toContainText('No provider reaches Blog');

  await editor.getByRole('button', { name: 'Show preview' }).click();
  const preview = editor.getByRole('region', { name: 'Publish confirmation' });
  await expect(preview).toContainText('X → @gholmes · Ready to send');
  await preview.getByRole('button', { name: 'Confirm and submit' }).click();

  // The submission is reported in the provider's words, grouped and said, per account.
  await expect(delivery).toContainText('Accepted, not out yet');
  await expect(delivery).toContainText('@gholmes');
  await expect(delivery).toContainText('Automatic publishing');
  await expect(delivery).toContainText('Not checked with the provider yet.');

  // Manual refresh is always available and records when it last asked.
  await delivery.getByRole('button', { name: 'Refresh delivery' }).click();
  await expect(delivery).toContainText('Last checked');

  // None of that is a claim about the plan: the status is still the one the user chose.
  await expect(editor.getByLabel('Planning status')).toHaveValue('SCHEDULED');
  const reread = await page.request.get(`/api/signal/posts/${(await created.json()).id}`);
  expect((await reread.json()).status).toBe('SCHEDULED');
});

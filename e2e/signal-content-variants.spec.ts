import { expect, test } from '@playwright/test';

/**
 * Wave 7's milestone flow: tailor a post per platform, ask for the preview, read what each target
 * would receive, and publish it without a real provider anywhere in the run.
 *
 * The two channels are deliberate. X and LinkedIn take the same media and the same shape, so the
 * only thing separating what they receive is the override — which is exactly what the preview has to
 * show, one tab at a time.
 */
test('platform overrides reach the preview per target and publish through the mock provider', async ({
  page,
}) => {
  const text = `Wave 7 variants ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['x', 'li'],
      mediaUrls: ['https://cdn.example.com/wave-7.jpg'],
      date: '2099-11-12',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  await page.goto('/signal?month=2099-11');
  const post = page
    .getByRole('region', { name: '2099-11-12' })
    .locator('.signal-post')
    .filter({ hasText: text });
  await post.getByRole('button', { name: `Edit ${text}` }).click();
  const editor = page.getByRole('dialog');

  // X gets its own, shorter caption and the link as a first comment. LinkedIn is left alone, so it
  // still receives the post itself — the inheritance, from the outside.
  const xPanel = editor.locator('details[data-platform="twitter"]');
  await xPanel.locator('summary').click();
  await xPanel.getByLabel('Caption for X').fill('The short version, for X.');
  await xPanel.getByLabel('First comment').fill('gholmesdesigns.com');
  await editor.getByRole('button', { name: 'Save per-platform content' }).click();
  await expect(editor.getByRole('button', { name: 'Per-platform content saved' })).toBeVisible();

  // Nothing was previewed while the overrides were being typed, and nothing was submitted.
  expect(await (await page.request.get(`/api/signal/posts/${postId}/publications`)).json()).toEqual(
    [],
  );

  await editor.getByRole('button', { name: 'Show preview' }).click();
  const preview = editor.getByRole('region', { name: 'Publish confirmation' });
  await expect(preview).toContainText('X → @gholmes · Ready to send');

  // One tab per target account, each answering for itself.
  await preview.getByRole('tab', { name: /^X/ }).click();
  const panel = preview.getByRole('tabpanel');
  await expect(panel).toContainText('The short version, for X.');
  await expect(panel).toContainText('Caption from the platform override');
  await expect(panel).toContainText('First comment: gholmesdesigns.com');
  await expect(panel).toContainText('2099-11-12 at 09:00 in America/New_York');
  await expect(panel).toContainText('2099-11-12T14:00:00.000Z');
  await expect(panel).toContainText('Sent by the provider');
  // The media is listed in order, by its own address. `cdn.example.com` does not resolve from a
  // test machine, so this run also exercises the fallback: a real browser fails the request and the
  // preview says so instead of showing a gap. The `referrerPolicy` attribute is asserted in
  // `client/src/Signal.variants.test.tsx`, where the image is not fetched and cannot be replaced by
  // its own error state before the assertion runs.
  await expect(panel).toContainText('Media 1 · image');
  await expect(panel).toContainText('This media could not be shown here.');
  await expect(panel.getByRole('link', { name: /Open/ })).toHaveAttribute(
    'href',
    'https://cdn.example.com/wave-7.jpg',
  );

  await preview.getByRole('tab', { name: /^LinkedIn/ }).click();
  const linkedin = preview.getByRole('tabpanel');
  await expect(linkedin).toContainText(text);
  await expect(linkedin).not.toContainText('The short version, for X.');

  await preview.getByRole('button', { name: 'Confirm and submit' }).click();
  await expect(editor.getByRole('region', { name: 'Publishing history' })).toContainText(
    'SUBMITTED',
  );
  // The post's own status is still the user's to set, and the tailored content is still stored.
  await expect(editor.getByLabel('Status')).toHaveValue('SCHEDULED');
  const stored = await (await page.request.get(`/api/signal/posts/${postId}/variants`)).json();
  expect(stored).toMatchObject([
    { platform: 'twitter', accountId: null, caption: 'The short version, for X.' },
  ]);
});

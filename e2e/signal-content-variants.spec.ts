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
  await expect(panel).toContainText('Automatic publishing');
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
  await expect(editor.getByRole('region', { name: 'Delivery' })).toContainText(
    'Accepted, not out yet',
  );
  // The post's own status is still the user's to set, and the tailored content is still stored.
  await expect(editor.getByLabel('Planning status')).toHaveValue('SCHEDULED');
  const stored = await (await page.request.get(`/api/signal/posts/${postId}/variants`)).json();
  expect(stored).toMatchObject([
    { platform: 'twitter', accountId: null, caption: 'The short version, for X.' },
  ]);
});

/**
 * Wave 12's milestone flow: two accounts on one platform, each receiving its own caption, in one
 * provider request (C77).
 *
 * Facebook because it is the one platform C73's live probe verified `account_configurations` on
 * (`docs/post-bridge-api-surface.md` §14, question 1). Two pages are connected and neither is
 * implied: the post chooses both explicitly, which is what replaces §3.1's one-account rule.
 *
 * The same-platform policy rule is exercised on the way through — both pages start with the post's
 * own caption, which is refused, and the run only reaches a submission once each has its own words.
 */
test('two chosen Facebook accounts each receive their own caption in one request', async ({
  page,
}) => {
  const text = `Wave 12 accounts ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: { text, channels: ['fb'], date: '2099-11-13', time: '10:00', status: 'SCHEDULED' },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  await page.goto('/signal?month=2099-11');
  const post = page
    .getByRole('region', { name: '2099-11-13' })
    .getByRole('button', { name: new RegExp(text.slice(0, 20)) });
  await post.click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Show preview' }).click();
  const preview = editor.getByRole('region', { name: 'Publish confirmation' });

  // Nothing chosen yet: the channel resolves to its single account exactly as it always has.
  await expect(preview).toContainText('No account chosen');

  // Choose both pages, and save. The plan hash covers the ids, so this re-previews.
  const accounts = preview.getByRole('group', { name: 'Accounts' });
  await accounts.getByRole('checkbox', { name: 'gholmesdesigns' }).check();
  await accounts.getByRole('checkbox', { name: 'wildeyephoto' }).check();
  await accounts.getByRole('button', { name: 'Save accounts' }).click();

  // Both accounts are named, and neither is collapsed into a sentence about the platform.
  await expect(preview).toContainText('gholmesdesigns');
  await expect(preview).toContainText('wildeyephoto');

  // Identical content to two accounts on one platform is refused before anything is sent.
  await expect(preview).toContainText(/same caption and media/i);
  await expect(preview.getByRole('button', { name: 'Confirm and submit' })).toBeDisabled();

  // Give each page its own words through the account layer, one tab at a time.
  const stored = await page.request.put(`/api/signal/posts/${postId}/variants`, {
    data: {
      variants: [
        { platform: 'facebook', accountId: 902, caption: 'For the studio’s own page.' },
        { platform: 'facebook', accountId: 906, caption: 'For the photography page.' },
      ],
    },
  });
  expect(stored.ok()).toBe(true);

  // Reopen rather than re-click: **Show preview** is gone once a preview is on screen, which is
  // the point of it — a plan is taken once and confirmed against its own hash.
  await page.reload();
  const reopened = page
    .getByRole('region', { name: '2099-11-13' })
    .getByRole('button', { name: new RegExp(text.slice(0, 20)) });
  await reopened.click();
  const second = page.getByRole('dialog');
  await second.getByRole('button', { name: 'Show preview' }).click();
  const settled = second.getByRole('region', { name: 'Publish confirmation' });
  // The selection survived the reload, and the collision is gone now each page has its own words.
  await expect(settled).toContainText('gholmesdesigns');
  await expect(settled).toContainText('wildeyephoto');
  await expect(settled).not.toContainText(/same caption and media/i);
  await settled.getByRole('button', { name: 'Confirm and submit' }).click();
  await expect(second.getByRole('region', { name: 'Delivery' })).toContainText(
    'Accepted, not out yet',
  );

  // One request, both accounts, each with its own caption — the card's headline claim.
  const publications = await (
    await page.request.get(`/api/signal/posts/${postId}/publications`)
  ).json();
  expect(
    publications[0].targets.map((target: { accountId: number }) => target.accountId).sort(),
  ).toEqual([902, 906]);
  expect(publications[0].sentAccountConfigurations).toMatchObject({
    version: 1,
    items: [
      { accountId: 902, caption: 'For the studio’s own page.' },
      { accountId: 906, caption: 'For the photography page.' },
    ],
  });
});

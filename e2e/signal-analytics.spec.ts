import { expect, test } from '@playwright/test';

/**
 * Wave 9: the numbers a post actually got, arriving because somebody asked for them.
 *
 * The path only a browser can prove is the whole of this card's shape end to end: a delivery
 * reconciliation captures the provider's result identity, the figures panel opens with nothing but a
 * sentence explaining why, one press reaches the provider, and the four counts and the
 * last-synchronised time appear. The rules behind availability, backoff, and daily gains are covered
 * against fixtures in `shared/publish-analytics.test.ts` and `server/publish/analytics.test.ts`.
 *
 * C80 extends it with the second question the same provider answers: a window read, which is one
 * request rather than a walk over every delivery. The browser is what proves the panel opens on
 * stored rows, that one press replaces a generation, that a row belonging to nothing here is counted
 * and kept out of the account totals, and that a second press which fails leaves the first read
 * exactly where it was.
 *
 * Specs share one database, so every locator is scoped to the post this spec created — and the window
 * assertions are scoped to the provider account they belong to rather than to a count, because the
 * denominator is every delivery in the file and other specs add to it.
 */
test('figures arrive only when asked, and an unmeasured channel says so rather than showing a zero', async ({
  page,
}) => {
  const text = `Wave 9 analytics ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      // TikTok is measured by this provider and X is not, so one post carries both answers. TikTok
      // needs media, and one image is a standard post there.
      channels: ['tt', 'x'],
      mediaUrls: ['https://example.com/frame.jpg'],
      date: '2099-09-15',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  // Submitted through the API: what this spec is about starts after a post has been delivered, and
  // the confirmed submit flow is already covered by `signal-publishing.spec.ts`.
  const preview = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  const submitted = await page.request.post(`/api/signal/posts/${postId}/publish`, {
    data: { planHash: (await preview.json()).planHash },
  });
  expect(submitted.ok()).toBe(true);

  await page.goto('/signal?month=2099-09');
  await page
    .getByRole('region', { name: '2099-09-15' })
    .locator('.signal-post')
    .filter({ hasText: text })
    .getByRole('button', { name: `Edit ${text}` })
    .click();
  const editor = page.getByRole('dialog');
  const figures = editor.getByRole('region', { name: 'Figures' });

  // Nothing has been synchronised for figures, and the panel says which of the reasons applies
  // rather than showing a count of nothing. Post-submit reconcile already captured the delivery
  // result id, so TikTok is ready to ask about figures rather than waiting on Refresh delivery.
  await expect(figures).toContainText('Not synchronised with the provider yet.');
  await expect(figures).toContainText('Figures refresh only when you ask.');
  // Filtered on the row's own channel name rather than on its text: the sentence an unmeasured row
  // carries names the three measured platforms, so `hasText` would match both rows.
  const rowFor = (channel: string) =>
    figures
      .locator('.signal-metric-target')
      .filter({ has: page.getByText(channel, { exact: true }) });
  const tiktok = rowFor('TikTok');
  const x = rowFor('X');
  await expect(tiktok).toContainText('No figures yet');
  await expect(x).toContainText('Not available from this provider');
  await expect(editor.getByRole('region', { name: 'Delivery' })).toContainText('Last checked');

  // One press, and the platform's own counts appear.
  await figures.getByRole('button', { name: 'Refresh figures' }).click();
  await expect(tiktok).toContainText('Figures from the platform');
  await expect(tiktok).toContainText((4210).toLocaleString('en-US'));
  await expect(tiktok).toContainText((318).toLocaleString('en-US'));
  await expect(figures).toContainText('Last synchronised');
  // C79: the provenance beside the counts says how the provider matched the record to the content
  // on the platform, and says in the same breath that it is not a caveat on the counts themselves.
  await expect(tiktok).toContainText('Provider match: Exact');
  await expect(tiktok).toContainText('Platform post: tt-e2e-7788');
  await expect(tiktok).toContainText('does not qualify or discount the counts');
  // The identifier is text. The provider's own address is the one link on the row.
  await expect(tiktok.getByRole('link')).toHaveAttribute(
    'href',
    'https://tiktok.example/video/e2e',
  );
  // X still has no figure at all after a refresh that reached the provider, which is the claim: this
  // provider does not measure it, and that is not a zero.
  await expect(x).toContainText('Not available from this provider');

  // The daily history is per-day gains derived from the snapshots, not the cumulative counts.
  await tiktok.getByText('One day of history').click();
  await expect(tiktok.getByRole('table')).toContainText((1210).toLocaleString('en-US'));

  // And the figures path changed nothing about the plan or the delivery.
  const reread = await page.request.get(`/api/signal/posts/${postId}`);
  expect(await reread.json()).toMatchObject({ status: 'SCHEDULED', date: '2099-09-15' });

  // ---------------------------------------------------------------------------------------------
  // C80: the same provider, asked what it reports over one of its own windows.
  // ---------------------------------------------------------------------------------------------
  await editor.getByRole('button', { name: 'Close editor' }).click();
  const windowPanel = page.getByRole('region', {
    name: 'What the provider reports over a window',
  });

  // Opening the planner read stored rows and nothing else — no window has been read yet.
  await expect(windowPanel).toContainText('This window has never been read.');
  // The panel says what a window total is not, beside where the numbers will be.
  await expect(windowPanel).toContainText(
    'Nothing here is a rate, an average, or a share of anything',
  );

  // One press, and the whole generation is replaced.
  await windowPanel.getByRole('button', { name: 'Refresh window' }).click();
  await expect(windowPanel).toContainText('Last complete read');

  // The mapped account carries the provider's own counts, added over the deliveries it named. These
  // are the window fixture's numbers and not the per-delivery fixture's, which is what proves the
  // panel read `signal_analytics_window_metrics` rather than the figures the Figures panel stored.
  const account = windowPanel.locator('.signal-window-group').filter({ hasText: 'Account 904' });
  await expect(account).toContainText((5117).toLocaleString('en-US'));
  await expect(account).toContainText((402).toLocaleString('en-US'));
  await expect(account).toContainText('named in this window');
  await expect(account).not.toContainText((4210).toLocaleString('en-US'));

  // A row the provider named that nothing here claims is counted, shown, and kept out of the account
  // totals above — which is the difference between a window and an account aggregate.
  const unmapped = windowPanel.locator('.signal-window-unmapped');
  await expect(unmapped).toContainText('match no delivery recorded here');
  await expect(unmapped).toContainText('made-in-post-bridge');
  await expect(unmapped).toContainText((9000).toLocaleString('en-US'));
  await expect(account).not.toContainText((9000).toLocaleString('en-US'));

  // A second press fails. The reason appears and the first read survives whole.
  await windowPanel.getByRole('button', { name: 'Refresh window' }).click();
  await expect(windowPanel).toContainText('nothing was replaced');
  await expect(account).toContainText((5117).toLocaleString('en-US'));
  await expect(unmapped).toContainText('made-in-post-bridge');

  // The window path touched neither the post nor its per-delivery figures. The per-delivery totals
  // are still the ones the Figures panel synchronised, untouched by a window read that stored
  // different numbers for the same delivery — which is the two-stores rule, on screen.
  const afterWindow = await page.request.get(`/api/signal/posts/${postId}`);
  expect(await afterWindow.json()).toMatchObject({ status: 'SCHEDULED', date: '2099-09-15' });
  const metrics = await page.request.get(`/api/signal/posts/${postId}/metrics`);
  expect(await metrics.json()).toMatchObject({
    targets: expect.arrayContaining([
      expect.objectContaining({ totals: { views: 4210, likes: 318, comments: 24, shares: 61 } }),
    ]),
  });
});

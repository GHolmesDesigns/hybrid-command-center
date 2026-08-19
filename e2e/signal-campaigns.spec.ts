import { expect, test, type Page } from '@playwright/test';

/**
 * Wave 9: two campaigns, the figures that came back for each, and the filters that separate them.
 *
 * The milestone end-to-end for campaign context. The path only a browser can prove is the whole
 * shape at once: a campaign typed into a post's editor becomes a shared row, two delivered posts in
 * two campaigns are grouped apart, the figures a person asked for are added up per campaign, and the
 * campaign and date filters narrow the panel and survive in the address. The grouping arithmetic is
 * covered against fixtures in `shared/signal-campaign-analytics.test.ts`, the gather in
 * `server/publish/campaign-analytics.test.ts`, and the vocabulary's writes in
 * `server/signal/campaigns.test.ts`.
 *
 * Specs share one database, so every campaign here carries this run's own stamp and every assertion
 * is scoped to the groups it created — the workspace also holds whatever the earlier specs left.
 */

const MEDIA = 'https://example.com/frame.jpg';

/** A scheduled TikTok post: the one channel the mock provider reports figures for. */
async function createPost(
  page: Page,
  input: { text: string; date: string; campaigns?: string[] },
): Promise<string> {
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text: input.text,
      channels: ['tt'],
      mediaUrls: [MEDIA],
      date: input.date,
      time: '09:00',
      status: 'SCHEDULED',
      ...(input.campaigns ? { campaigns: input.campaigns } : {}),
    },
  });
  expect(created.ok()).toBe(true);
  return (await created.json()).id as string;
}

/**
 * Submits a post, has the provider's answer read back so the delivery carries a result identity, and
 * stores the figures that identity answers for.
 *
 * Through the API: the confirmed submit flow is `signal-publishing.spec.ts`'s and the per-post
 * figures panel is `signal-analytics.spec.ts`'s. What this spec is about starts once two posts in
 * two campaigns have numbers against them.
 */
async function deliverAndMeasure(page: Page, postId: string) {
  const preview = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  const submitted = await page.request.post(`/api/signal/posts/${postId}/publish`, {
    data: { planHash: (await preview.json()).planHash },
  });
  expect(submitted.ok()).toBe(true);
  const publicationId = (await submitted.json()).id as string;

  const reconciled = await page.request.post(
    `/api/signal/publications/${publicationId}/reconcile`,
    {
      data: { automatic: false },
    },
  );
  expect(reconciled.ok()).toBe(true);

  const measured = await page.request.post(`/api/signal/posts/${postId}/metrics/refresh`);
  expect(measured.ok()).toBe(true);
  const summary = await measured.json();
  // The figures really did arrive, so a later assertion of zero would be a defect rather than a
  // provider that had nothing to say.
  expect(
    summary.targets.some((target: { availability: string }) => target.availability === 'AVAILABLE'),
  ).toBe(true);
}

test('two campaigns are grouped apart, added up from the provider’s own figures, and filterable', async ({
  page,
}) => {
  const stamp = Date.now();
  const first = `Wave9 Clarity ${stamp}`;
  const second = `Wave9 Explain ${stamp}`;
  const octoberText = `Wave 9 campaign October ${stamp}`;
  const novemberText = `Wave 9 campaign November ${stamp}`;
  const looseText = `Wave 9 campaign unclassified ${stamp}`;

  // The first campaign is written with the post; the second is typed into the editor below, so both
  // ways of attaching one are exercised.
  const october = await createPost(page, {
    text: octoberText,
    date: '2099-10-05',
    campaigns: [first],
  });
  const november = await createPost(page, { text: novemberText, date: '2099-11-05' });
  await createPost(page, { text: looseText, date: '2099-10-06' });

  // A campaign typed into a post's editor, saved with the post, and resolved into the shared list.
  await page.goto('/signal?month=2099-11');
  await page
    .getByRole('region', { name: '2099-11-05' })
    .getByRole('button', { name: `Edit ${novemberText}` })
    .click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Add a campaign').fill(second);
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(editor.getByRole('button', { name: `Remove campaign ${second}` })).toBeVisible();
  await editor.getByRole('button', { name: 'Save post' }).click();
  await expect(editor).toBeHidden();

  // It is a row in the shared vocabulary now, not text on one post.
  const vocabulary = await (await page.request.get('/api/signal/campaigns')).json();
  const secondCampaign = vocabulary.find((campaign: { name: string }) => campaign.name === second);
  expect(secondCampaign).toBeTruthy();
  expect(secondCampaign.postCount).toBe(1);
  const firstCampaign = vocabulary.find((campaign: { name: string }) => campaign.name === first);
  expect(firstCampaign).toBeTruthy();

  await deliverAndMeasure(page, october);
  await deliverAndMeasure(page, november);

  // What the provider gave each delivery, read back from the API in this same run rather than
  // hard-coded: the figure the panel shows has to be that number and not a number this spec chose.
  const measured = await (
    await page.request.get(
      `/api/signal/analytics/campaigns?campaigns=${firstCampaign.id},${secondCampaign.id}`,
    )
  ).json();
  const groupFor = (name: string) =>
    measured.groups.find((group: { name: string }) => group.name === name);
  expect(groupFor(first).measuredDeliveries).toBe(1);
  expect(groupFor(second).measuredDeliveries).toBe(1);
  const firstViews = groupFor(first).totals.views as number;
  const bothViews = measured.totals.views as number;
  expect(firstViews).toBeGreaterThan(0);
  expect(bothViews).toBe(firstViews + (groupFor(second).totals.views as number));

  await page.goto('/signal?month=2099-10');
  const panel = page.getByRole('region', { name: 'Campaign figures' });
  const group = (name: string) => panel.locator('.signal-campaign-group').filter({ hasText: name });

  // Both campaigns are on the page, apart, each with its own figures — and unclassified posts are
  // still visible under No campaign rather than disappearing from the view.
  await expect(group(first)).toContainText(firstViews.toLocaleString('en-US'));
  await expect(group(second)).toBeVisible();
  await expect(panel.locator('.signal-campaign-group.is-uncategorized')).toContainText(
    'No campaign',
  );

  // One campaign selected: the other group goes, and the total is that campaign's alone.
  await panel.getByRole('button', { name: first, exact: true }).click();
  await expect(panel.getByRole('button', { name: first, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(group(second)).toHaveCount(0);
  await expect(panel.locator('.signal-campaign-group.is-uncategorized')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`campaigns=${firstCampaign.id}`));

  // Both selected: or, not and. Two groups, and the total is the sum of the two.
  await panel.getByRole('button', { name: second, exact: true }).click();
  await expect(group(first)).toBeVisible();
  await expect(group(second)).toBeVisible();
  await expect(panel.getByLabel('Figures across every campaign in scope')).toContainText(
    bothViews.toLocaleString('en-US'),
  );

  // A date range asks which posts: October leaves the November campaign with nothing in scope.
  await panel.getByLabel('From').fill('2099-10-01');
  // Awaited between the two fills: each one is its own navigation, and `fill` can outrun a render
  // in a way a person filling two date fields cannot.
  await expect(page).toHaveURL(/from=2099-10-01/);
  await panel.getByLabel('To').fill('2099-10-31');
  await expect(page).toHaveURL(/to=2099-10-31/);
  await expect(group(first)).toBeVisible();
  await expect(group(second)).toHaveCount(0);
  await expect(panel.getByLabel('Figures across every campaign in scope')).toContainText(
    firstViews.toLocaleString('en-US'),
  );

  // The filters are durable: a reload arrives on the same answer, from the address alone.
  await page.reload();
  await expect(group(first)).toBeVisible();
  await expect(group(second)).toHaveCount(0);

  await panel.getByRole('button', { name: 'Clear filters' }).click();
  await expect(group(second)).toBeVisible();
  await expect(page).not.toHaveURL(/campaigns=/);
  // Clearing the panel's filters leaves the planner's own month exactly where it was.
  await expect(page).toHaveURL(/month=2099-10/);

  // Renaming the campaign is one write and reaches the post that carries it.
  const renamed = `${first} renamed`;
  const rename = await page.request.patch(`/api/signal/campaigns/${firstCampaign.id}`, {
    data: { name: renamed },
  });
  expect(rename.ok()).toBe(true);
  const reread = await (await page.request.get(`/api/signal/posts/${october}`)).json();
  expect(reread.campaigns.map((campaign: { name: string }) => campaign.name)).toEqual([renamed]);

  // And deleting it detaches without deleting a post: the post is still there, still scheduled,
  // and now reads under No campaign.
  const detached = await page.request.delete(
    `/api/signal/campaigns/${firstCampaign.id}?confirm=true`,
  );
  expect(detached.ok()).toBe(true);
  const survivor = await (await page.request.get(`/api/signal/posts/${october}`)).json();
  expect(survivor).toMatchObject({ date: '2099-10-05', status: 'SCHEDULED', campaigns: [] });
});

import { expect, test } from '@playwright/test';

/**
 * Wave 13: a post nobody here made, surfacing because somebody pressed refresh.
 *
 * The card's claim is that a post created in the Post Bridge UI, by a VA, or by an agent is invisible
 * to this app — and that it is the thing most likely to collide with a slot the planner believes is
 * empty. So this walks the whole of that: the panel opens having contacted nothing, one press reads
 * the provider, the post this app did not send is marked as such beside one it did, the alert appears
 * above the planner, and acknowledging it changes nothing but the alert.
 *
 * The pagination itself — several pages, a repeated offset, a malformed row, a page that fails — is
 * covered against fixtures in `server/publish/inventory.test.ts`, where each of those can be arranged
 * exactly. What only a browser can prove is this flow.
 *
 * Specs share one database, so every locator here is scoped to the panel or to the post this spec
 * created.
 */
test('a refresh surfaces a post the app did not send, and acknowledging it changes nothing else', async ({
  page,
}) => {
  const text = `Wave 13 inventory ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: { text, channels: ['x'], date: '2099-09-15', time: '09:00', status: 'SCHEDULED' },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  // Submitted through the API, so one of the provider's two listed posts is one this app sent. The
  // confirmed submit flow itself is covered by `signal-publishing.spec.ts`.
  const preview = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  const submitted = await page.request.post(`/api/signal/posts/${postId}/publish`, {
    data: { planHash: (await preview.json()).planHash },
  });
  expect(submitted.ok()).toBe(true);

  await page.goto('/signal?month=2099-09');
  const inventory = page.getByRole('region', { name: 'What Post Bridge is holding' });

  // Opening the planner read stored rows and nothing else: there is nothing to show yet, and the
  // panel says so rather than showing an empty list as though the provider were empty.
  await expect(inventory).toContainText('Nothing has been read from the provider yet.');
  await expect(inventory).toContainText('Press Refresh inventory');

  await inventory.getByRole('button', { name: 'Refresh inventory' }).click();
  await expect(inventory).toContainText('2 posts at the provider, 1 of them not sent from here');

  // The one this app did not send says so in words, names its slot and its account, and carries the
  // provider's own id.
  const orphan = inventory
    .locator('.signal-inventory-row')
    .filter({ hasText: 'Scheduled straight in Post Bridge, not from here' });
  await expect(orphan).toContainText('Not sent from here');
  await expect(orphan).toContainText('Scheduled with the provider');
  await expect(orphan).toContainText('e2e-provider-orphan');
  // And the one it did send is in the same list, marked the other way.
  await expect(
    inventory.locator('.signal-inventory-row').filter({ hasText: 'Submitted by this app' }),
  ).toContainText('Sent from here');

  // Nothing in the panel writes: one control, and it is the refresh.
  await expect(inventory.getByRole('button')).toHaveCount(1);
  await expect(inventory).toContainText('Nothing here can adopt, edit, reschedule, or withdraw');

  // Above the planner, the alert derived from those stored rows. The summary was read before the
  // refresh, so it is asked for again — which is the whole of what "derived, never stored" means here.
  const health = page.getByRole('region', { name: 'What needs attention' });
  await health.getByRole('button', { name: 'Refresh health' }).click();
  const alert = health.locator('.signal-health-alert').filter({ hasText: 'Provider inventory' });
  await expect(alert).toContainText('Worth watching');
  await expect(alert).toContainText('1 post in Post Bridge this app did not send');
  await expect(alert).toContainText('Scheduled straight in Post Bridge, not from here');

  await alert.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(alert).toHaveCount(0);
  await health.getByRole('button', { name: /acknowledged$/ }).click();
  await expect(
    health.locator('.signal-health-alert').filter({ hasText: 'Provider inventory' }),
  ).toContainText('Acknowledged');

  // The plan is exactly as it was, the provider's post is still listed, and the app did not adopt it.
  const reread = await page.request.get(`/api/signal/posts/${postId}`);
  expect(await reread.json()).toMatchObject({
    status: 'SCHEDULED',
    date: '2099-09-15',
    time: '09:00',
  });
  const snapshot = await page.request.get('/api/signal/provider-inventory');
  const entries = (await snapshot.json()).entries as { providerPostId: string; orphan: boolean }[];
  expect(entries.find((entry) => entry.providerPostId === 'e2e-provider-orphan')?.orphan).toBe(
    true,
  );

  // One integration event for the one refresh, saying what it did and touching no local record.
  const activity = await page.request.get('/api/integrations/activity?limit=50');
  const refreshes = ((await activity.json()) as { operation: string; outcome: string }[]).filter(
    (event) => event.operation === 'signal.provider-inventory-refresh',
  );
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]?.outcome).toBe('SUCCESS');
});

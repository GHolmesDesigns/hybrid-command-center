import { expect, test, type Page } from '@playwright/test';
import { E2E_RESET_ADS_PATH, e2eApiOrigin } from './endpoints.ts';

/**
 * C259 (Milestone B): the read-only Ads performance page, end to end, against the mock provider in
 * `e2e/start-server.ts`. Nothing here contacts Google.
 *
 * The flow: connect and approve two accounts through the real routes, map one to a client, open
 * `/ads` and see that opening it read nothing from Google, refresh on purpose, filter by client,
 * account, and date with the filters surviving a reload and Back, then drive one scripted failed
 * refresh and see the last-good figures stay behind a stale banner until a refresh succeeds.
 *
 * Specs share one server and one database, so counts are taken from the activity log before and
 * after rather than assumed.
 */
const syncEvents = async (page: Page) =>
  (
    (await (await page.request.get('/api/integrations/activity?limit=200')).json()) as {
      source: string;
      operation: string;
      outcome: string;
    }[]
  ).filter((event) => event.source === 'google-ads' && event.operation === 'ads.sync');

test('shows stored Ads figures read-only, filters them durably, and keeps last-good data when a refresh fails', async ({
  page,
}) => {
  // Connect through the mock authorization server unless a prior spec left Ads connected.
  const status = await (await page.request.get('/api/ads/status')).json();
  if (status.status !== 'CONNECTED') {
    const started = await (await page.request.get('/api/ads/oauth/start')).json();
    await page.goto(started.url);
    await expect(page).toHaveURL(/\/settings/);
  }
  await page.request.post('/api/ads/accounts/discover');
  for (const customerId of ['1234567890', '2345678901']) {
    const approved = await page.request.post(`/api/ads/accounts/${customerId}/approve`, {
      data: { confirmCustomerId: customerId },
    });
    expect(approved.ok()).toBe(true);
  }

  // Map the US account to a client; the Berlin account stays Unassigned.
  const clientName = `E2E Ads Client ${Date.now()}`;
  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  const preview = await (
    await page.request.post('/api/ads/accounts/1234567890/mapping/preview', {
      data: { clientId: client.id },
    })
  ).json();
  const mapped = await page.request.post('/api/ads/accounts/1234567890/mapping', {
    data: { clientId: client.id, planHash: preview.planHash },
  });
  expect(mapped.ok()).toBe(true);

  const eventsBefore = (await syncEvents(page)).length;
  const refreshRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/ads/performance/refresh')) refreshRequests.push(request.url());
  });

  // Opening the page reads the stored snapshot only: no refresh request, no sync event.
  await page.goto('/ads');
  await expect(page.getByRole('heading', { level: 1, name: 'Ads performance' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ads', exact: true })).toBeVisible();
  const usAccount = page.getByRole('article', { name: 'Account Agency account' });
  const berlinAccount = page.getByRole('article', { name: 'Account Berlin account' });
  await expect(usAccount.getByText('No figures yet.')).toBeVisible();
  await expect(berlinAccount.getByText('No figures yet.')).toBeVisible();
  expect(refreshRequests).toHaveLength(0);
  expect(await syncEvents(page)).toHaveLength(eventsBefore);

  // Refresh is the one deliberate action.
  await page.getByRole('button', { name: 'Refresh from Google' }).click();
  await expect(usAccount.getByRole('row', { name: /E2E Search/ })).toBeVisible();
  expect(refreshRequests).toHaveLength(1);
  expect(await syncEvents(page)).toHaveLength(eventsBefore + 1);

  // Provider daily values are added per account and per currency; nothing combines USD with EUR.
  const totals = page.getByRole('region', { name: 'Totals for this view' });
  await expect(totals.getByLabel('Totals in USD')).toContainText('1,500');
  await expect(totals.getByLabel('Totals in USD')).toContainText('$30.00');
  await expect(totals.getByLabel('Totals in EUR')).toContainText('70');
  await expect(totals.getByLabel(/^Totals in /)).toHaveCount(2);

  // A campaign with no metric rows appears, with words rather than zeros.
  await expect(usAccount.getByRole('row', { name: /E2E Idle/ })).toContainText(
    'No metric rows reported',
  );

  // The unassigned account is a visible group, with its own time zone.
  const unassigned = page.getByRole('region', { name: 'Client: Unassigned' });
  await expect(unassigned).toBeVisible();
  await expect(unassigned.getByText('Time zone Europe/Berlin')).toBeVisible();
  await expect(page.getByRole('region', { name: `Client: ${clientName}` })).toBeVisible();

  // Filters live in the address and survive reload and Back/Forward.
  await page.locator('[name=client]').selectOption(client.id);
  await expect(page).toHaveURL(new RegExp(`client=${client.id}`));
  await expect(berlinAccount).toHaveCount(0);
  await expect(totals.getByLabel(/^Totals in /)).toHaveCount(1);
  await page.reload();
  await expect(page.locator('[name=client]')).toHaveValue(client.id);
  await expect(berlinAccount).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/client=/);
  await expect(berlinAccount).toBeVisible();

  await page.locator('[name=account]').selectOption('2345678901');
  await expect(page).toHaveURL(/account=2345678901/);
  await expect(usAccount).toHaveCount(0);

  // A date range inside the stored window with no measured day has no totals and no zeros.
  const bounds = await page
    .getByLabel('From', { exact: true })
    .evaluate((input: HTMLInputElement) => ({
      min: input.min,
      max: input.max,
    }));
  await page.locator('[name=account]').selectOption('');
  await page.locator('[name=to]').fill(bounds.min);
  await expect(page).toHaveURL(new RegExp(`to=${bounds.min}`));
  await expect(
    page.getByText(/No measured days in this view, so there are no totals/),
  ).toBeVisible();
  await expect(totals.getByLabel(/^Totals in /)).toHaveCount(0);

  // An invalid or retired value falls back without breaking the page.
  await page.goto('/ads?client=retired&from=2020-01-01');
  await expect(page.getByRole('heading', { level: 1, name: 'Ads performance' })).toBeVisible();
  await expect(page.getByText(/does not have, so that filter was not applied/)).toBeVisible();
  await expect(usAccount).toBeVisible();

  // The next refresh is scripted to fail: the last-good figures stay, behind a stale banner.
  const goodSnapshot = await (await page.request.get('/api/ads/performance')).json();
  await page.getByRole('button', { name: 'Refresh from Google' }).click();
  const stale = page.getByRole('alert').filter({ hasText: 'The latest refresh failed' });
  await expect(stale).toBeVisible();
  await expect(stale).toContainText('e2e scripted day-query failure');
  await expect(stale).toContainText('last successful snapshot');
  await expect(usAccount.getByRole('row', { name: /E2E Search/ })).toBeVisible();
  const afterFailure = await (await page.request.get('/api/ads/performance')).json();
  expect(afterFailure.lastAttemptFailed).toBe(true);
  expect(afterFailure.accounts).toEqual(goodSnapshot.accounts);

  // The stale state survives a reload, because it is stored, not remembered by the page.
  await page.reload();
  await expect(stale).toBeVisible();

  // A later successful refresh clears it.
  await page.getByRole('button', { name: 'Refresh from Google' }).click();
  await expect(stale).toHaveCount(0);
  await expect(page.getByText('The latest refresh succeeded.')).toBeVisible();

  // At a phone width the page does not scroll sideways and the zone labels stay readable.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(berlinAccount.getByText('Time zone Europe/Berlin')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // Leave Ads as this spec found it: disconnected, with nothing approved or kept, so later specs
  // (Settings' card layout among them) see the same page they would without this one.
  await page.request.post('/api/ads/disconnect');
  const reset = await page.request.post(`${e2eApiOrigin}${E2E_RESET_ADS_PATH}`);
  expect(reset.status()).toBe(204);
  expect((await (await page.request.get('/api/ads/accounts')).json()).accounts).toEqual([]);
});

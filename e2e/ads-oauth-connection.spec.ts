import { expect, test, type Page } from '@playwright/test';

/**
 * C256: connect and disconnect Google Ads from Settings, against the mock authorization server in
 * `e2e/start-server.ts`. Nothing here contacts Google. The flow runs the real start route, the real
 * callback with its state, the account-list gate, and the encrypted store; only Google's consent
 * screen and token endpoint are replaced.
 *
 * Counts are taken from the activity log before and after, so the spec does not depend on what
 * another spec left behind.
 */
const adsEvents = async (page: Page) => {
  const activity = await page.request.get('/api/integrations/activity?limit=200');
  return (
    (await activity.json()) as { source: string; operation: string; outcome: string }[]
  ).filter((event) => event.source === 'google-ads');
};

test('connects through the callback, survives a reload and a refused reconnect, and disconnects', async ({
  page,
}) => {
  const eventsBefore = (await adsEvents(page)).length;
  const driveBefore = await (await page.request.get('/api/settings/drive')).json();

  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Google Ads' });
  await expect(card.getByText('Ads offline')).toBeVisible();
  expect((await (await page.request.get('/api/ads/status')).json()).status).toBe('DISCONNECTED');

  // Connect: start -> mock consent -> callback -> back on Settings with the result.
  await card.getByRole('button', { name: 'Connect Google Ads' }).click();
  await expect(page).toHaveURL(/\/settings(\?|$)/);
  await expect(card.getByText('Google Ads connected', { exact: true })).toBeVisible();
  await expect(card.getByText('Ads connected', { exact: true })).toBeVisible();
  // The notice is consumed from the address so a reload does not replay it.
  await expect(page).not.toHaveURL(/ads=/);

  const status = await (await page.request.get('/api/ads/status')).json();
  expect(status).toMatchObject({ configured: true, status: 'CONNECTED' });
  expect(JSON.stringify(status)).not.toMatch(/token|secret|e2e-ads-code|mock-ads/i);

  // Reload: the connection is read from the server, not remembered by the page.
  await page.reload();
  await expect(card.getByText('Ads connected', { exact: true })).toBeVisible();
  await expect(card.getByText('Google Ads connected', { exact: true })).toHaveCount(0);

  // A refused reconnect leaves the prior connection exactly as it was.
  const started = await (await page.request.get('/api/ads/oauth/start')).json();
  const state = new URL(started.url).searchParams.get('state')!;
  await page.goto(`/api/ads/oauth/callback?state=${state}&error=access_denied`);
  await expect(page).toHaveURL(/\/settings/);
  await expect(card.getByText('Google Ads was not connected')).toBeVisible();
  await expect(card.getByText('Ads connected', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/ads/status')).json()).status).toBe('CONNECTED');

  // A state this app never issued is refused outright and changes nothing.
  const forged = await page.request.get('/api/ads/oauth/callback?state=forged&code=x', {
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(400);

  // Disconnect, after confirmation.
  page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Disconnect Google Ads' }).click();
  await expect(card.getByText('Ads offline')).toBeVisible();
  expect((await (await page.request.get('/api/ads/status')).json()).status).toBe('DISCONNECTED');
  await page.reload();
  await expect(card.getByText('Ads offline')).toBeVisible();

  // One redacted event per local outcome: connect, the refused reconnect, disconnect.
  const events = (await adsEvents(page)).slice(0, (await adsEvents(page)).length - eventsBefore);
  expect(events.map((event) => `${event.operation}:${event.outcome}`)).toEqual([
    'ads.disconnect:SUCCESS',
    'ads.connect:FAILURE',
    'ads.connect:SUCCESS',
  ]);

  // Drive was never involved.
  expect(await (await page.request.get('/api/settings/drive')).json()).toEqual(driveBefore);
});

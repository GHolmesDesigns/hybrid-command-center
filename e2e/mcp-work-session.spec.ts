import { expect, test } from '@playwright/test';

/** Wave 28 / C128: operator can inspect the bounded stale-session surface. */
test('operator can read reclaimable work sessions', async ({ page }) => {
  const response = await page.request.get('/api/agent-work-sessions');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual(expect.any(Array));
});

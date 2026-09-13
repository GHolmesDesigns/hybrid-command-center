import { test, expect } from '@playwright/test';

test('operator can open the health dashboard and re-check its separate signals', async ({
  page,
}) => {
  await page.goto('/health');
  await expect(page.getByRole('heading', { name: 'Application health' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Process liveness' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Database readiness' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historical agent activity' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Active remote-agent verification' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Re-check health' }).click();
  await expect(page.locator('.refresh-status')).toContainText('Overall status:');
});

import { test, expect } from '@playwright/test';
import { gotoSettled } from './ready';

const LOGO_URL = 'https://cdn.example.invalid/client-logo.svg';

test('client branding saves, survives reload, and returns to global fallback', async ({ page }) => {
  await page.route(LOGO_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32"/></svg>',
    }),
  );
  await gotoSettled(page, '/clients');
  await page.getByRole('button', { name: 'New client' }).first().click();
  await page.getByLabel('Client name').fill('E2E Branded Client');
  await page.getByLabel('Logo URL').fill(LOGO_URL);
  await page.getByLabel('Colour one').fill('#18201d');
  await page.getByLabel('Colour two').fill('#ffffff');
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByText('Client created.')).toBeVisible();

  await page.getByRole('link', { name: 'E2E Branded Client' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Branded Client' })).toBeVisible();
  await expect(page.locator('.client-branding-preview img')).toHaveAttribute(
    'alt',
    'E2E Branded Client',
  );
  await page.reload();
  await expect(page.locator('.client-branding-preview img')).toHaveCount(1);

  await page.getByRole('button', { name: 'Edit details' }).click();
  await page.getByRole('button', { name: 'Use global branding' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Client updated.')).toBeVisible();
  await expect(page.getByText('Global branding')).toBeVisible();
});

import { expect, test } from '@playwright/test';
import { gotoSettled } from './ready';

test('theme choice applies immediately and persists after reload', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('theme-test-initialized')) return;
    localStorage.removeItem('hcc-theme-mode');
    sessionStorage.setItem('theme-test-initialized', '1');
  });
  await gotoSettled(page, '/settings');
  const theme = page.getByRole('combobox', { name: 'Color theme' });

  await expect(theme).toHaveValue('system');
  await theme.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hcc-theme-mode'))).toBe('dark');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await gotoSettled(page, '/settings');
  await expect(page.getByRole('combobox', { name: 'Color theme' })).toHaveValue('dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await theme.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('hcc-theme-mode')))
    .toBe('system');
});

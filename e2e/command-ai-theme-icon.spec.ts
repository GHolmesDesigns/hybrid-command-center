import { expect, test } from '@playwright/test';
import { gotoSettled } from './ready';

const expectVisibleAsset = async (
  control: import('@playwright/test').Locator,
  visibleAsset: 'primary' | 'white',
) => {
  await expect(control.locator('.command-ai-glyph')).toBeVisible();
  await expect
    .poll(() =>
      control
        .locator('.command-ai-glyph-primary')
        .evaluate((image) => getComputedStyle(image).display),
    )
    .toBe(visibleAsset === 'primary' ? 'block' : 'none');
  await expect
    .poll(() =>
      control
        .locator('.command-ai-glyph-white')
        .evaluate((image) => getComputedStyle(image).display),
    )
    .toBe(visibleAsset === 'white' ? 'block' : 'none');
};

test('Command AI uses readable marks across light and dark themes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hcc-theme-mode', 'light'));
  await gotoSettled(page, '/');

  const topToggle = page.getByRole('button', { name: 'Command AI', exact: true });
  const launcher = page.getByRole('button', { name: 'Open Command AI' });
  await expect(topToggle).toBeVisible();
  await expect(launcher).toBeVisible();

  for (const [theme, surfaceAsset, inverseAsset] of [
    ['light', 'primary', 'white'],
    ['dark', 'white', 'primary'],
  ] as const) {
    await page
      .locator('html')
      .evaluate((element, value) => element.setAttribute('data-theme', value), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expectVisibleAsset(topToggle, surfaceAsset);
    await expectVisibleAsset(launcher, inverseAsset);

    await topToggle.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Command AI' });
    await expect(panel).toBeVisible();
    await expectVisibleAsset(panel.locator('.command-ai-brand'), surfaceAsset);
    await expect(page.getByRole('button', { name: 'Close Command AI' })).toBeVisible();
    await page.getByRole('button', { name: 'Close Command AI' }).click();
    await expect(launcher).toBeVisible();
  }
});

import { expect, test } from '@playwright/test';
import { gotoSettled } from './ready';

const routes = [
  '/ads',
  '/signal',
  '/files',
  '/health',
  '/agents',
  '/agents/conversations',
  '/settings',
];

test('integration and settings routes share the design system in both themes at a narrow width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoSettled(page, '/settings');

  for (const mode of ['light', 'dark'] as const) {
    await page.evaluate((theme) => localStorage.setItem('hcc-theme-mode', theme), mode);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

    for (const route of routes) {
      await gotoSettled(page, route);
      await expect(page.locator('.page-wrap')).toHaveClass(/workspace-design-system/);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
        .toBeLessThanOrEqual(1);
    }

    await page.keyboard.press('Tab');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle))
      .toBe('solid');
  }
});

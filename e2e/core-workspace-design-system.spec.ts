import { expect, test } from '@playwright/test';
import { gotoSettled } from './ready';

test('core workspace applies the design system across themes and a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('c279-theme-initialized')) return;
    localStorage.setItem('hcc-theme-mode', 'light');
    sessionStorage.setItem('c279-theme-initialized', '1');
  });
  await gotoSettled(page, '/');

  const workspace = page.locator('.workspace-design-system');
  const primaryAction = page.getByRole('button', { name: 'New project' }).first();
  await expect(workspace).toBeVisible();
  await expect(primaryAction).toHaveClass(/ghd-btn-primary/);
  await expect(workspace.locator('.dashboard-grid .ghd-card')).toHaveCount(2);
  await expect
    .poll(() => workspace.locator('h1').evaluate((heading) => getComputedStyle(heading).fontFamily))
    .toContain('Outfit');

  const lightSurface = await workspace.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await primaryAction.focus();
  await expect
    .poll(() => primaryAction.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('solid');

  await gotoSettled(page, '/settings');
  await page.getByRole('combobox', { name: 'Color theme' }).selectOption('dark');
  await gotoSettled(page, '/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(primaryAction).toBeVisible();
  const darkSurface = await workspace.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(darkSurface).not.toBe(lightSurface);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(primaryAction).toBeVisible();
  const pageWidth = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.content, JSON.stringify(pageWidth)).toBeLessThanOrEqual(pageWidth.viewport);
  await expect(workspace.locator('.dashboard-grid .ghd-card').nth(1)).toBeVisible();

  await gotoSettled(page, '/settings');
  await expect(page.locator('.workspace-design-system')).toHaveCount(0);
});

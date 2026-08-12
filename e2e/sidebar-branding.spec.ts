import { test, expect } from '@playwright/test';

const LOGO_URL = 'https://cdn.example.invalid/logo.svg';
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#f0c419"/></svg>';

/**
 * The Stage 3 spec for C15. What only a real browser can settle is that the palette the
 * form validates is the palette the sidebar is actually painted with, that it survives a
 * reload rather than living in React state, and that a logo address which stops resolving
 * still leaves a readable brand behind. The logo host is served by the test rather than
 * the internet, so the run stays offline and deterministic.
 */
test('sidebar colours and logo save, survive a reload, and refuse an unreadable palette', async ({
  page,
}) => {
  const original = (await (await page.request.get('/api/settings/branding')).json()).branding;
  const hex = (label: string) => page.getByLabel(`${label} hex value`);
  const reading = (text: string) => page.getByRole('listitem').filter({ hasText: text });
  const sidebar = page.locator('aside.sidebar');
  const save = page.getByRole('button', { name: 'Save branding' });
  const colorOf = (property: string) =>
    sidebar.evaluate(
      (element, name) => getComputedStyle(element).getPropertyValue(name).trim(),
      property,
    );

  await page.route(LOGO_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: LOGO_SVG }),
  );
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

  // An unreadable pair is refused in words, not by colour alone, and never reaches the API.
  await hex('Sidebar text').fill('#2a3330');
  await expect(reading('Sidebar text on the sidebar')).toContainText('Fails AA');
  await expect(save).toBeDisabled();

  await hex('Sidebar background').fill('#2b0f3a');
  await hex('Sidebar text').fill('#ffe9ff');
  await hex('Accent').fill('#f0c419');
  await expect(reading('Sidebar text on the sidebar')).toContainText('Passes AA');
  await expect(reading('Accent on the sidebar')).toContainText('Passes AA');
  await page.getByLabel('Logo address (optional)').fill(LOGO_URL);
  await page.getByLabel('Logo alt text').fill('E2E studio logo');
  await save.click();
  await expect(page.getByText('Sidebar branding saved.')).toBeVisible();

  await page.reload();
  await expect(sidebar).toBeVisible();
  expect(await colorOf('--sidebar-bg')).toBe('#2b0f3a');
  expect(await colorOf('--sidebar-fg')).toBe('#ffe9ff');
  expect(await colorOf('--sidebar-accent')).toBe('#f0c419');
  // Derived rather than chosen: the mark's lettering follows the background it sits against.
  expect(await colorOf('--sidebar-mark-ink')).toBe('#2b0f3a');
  await expect(sidebar).toHaveCSS('background-color', 'rgb(43, 15, 58)');
  // The logo replaced the text mark and carries its description.
  await expect(sidebar.locator('.brand-logo')).toHaveAttribute('alt', 'E2E studio logo');
  await expect(sidebar.locator('.brand-mark')).toHaveCount(0);

  // The same saved address, now unreachable — the state any remote logo can decay into.
  await page.unroute(LOGO_URL);
  await page.route(LOGO_URL, (route) => route.abort());
  await page.reload();
  await expect(sidebar.locator('.brand-mark')).toHaveText(original.mark);
  await expect(sidebar.locator('.brand-logo')).toHaveCount(0);

  // A palette the form blocks cannot be smuggled past it either.
  const rejected = await page.request.put('/api/settings/branding', {
    data: { ...original, background: '#2b0f3a', foreground: '#2f1741' },
  });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error).toContain('4.5:1');

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await save.click();
  await expect(page.getByText('Sidebar branding saved.')).toBeVisible();
  expect(await colorOf('--sidebar-bg')).toBe('#18201d');
  await expect(sidebar.locator('.brand-mark')).toHaveText('HC');
});

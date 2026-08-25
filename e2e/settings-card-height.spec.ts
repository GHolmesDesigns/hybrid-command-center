import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * The Wave 1 spec for C32. A stretched card is invisible to every other check in this
 * repository: jsdom has no layout engine, so a unit test can assert the Drive card's markup
 * and never notice that the browser drew it more than a thousand pixels taller than the
 * content it holds. Only a real browser settles it, and only by measuring.
 *
 * What is measured is the gap between the card's bottom and its last child's bottom, less the
 * two things allowed to be in that gap — the card's own `padding-bottom` and the last child's
 * `margin-bottom`. On a card that ends where its content ends, nothing else is left. On a card
 * the grid has stretched to a row it does not fill, the remainder is the blank area, and it is
 * as large as the mismatch. That is why the assertion is a couple of pixels of rounding rather
 * than a tolerance: a tolerance loose enough to absorb the padding would also absorb a bug.
 *
 * The cards are reached through the two column stacks C56 introduced rather than as the grid's
 * own children; what is measured, and what it proves, is unchanged. Where a card starts is that
 * card's spec, `settings-column-independence.spec.ts`. This one is only about where it ends.
 *
 * Both Drive states are covered, because they differ by a couple of hundred pixels and a
 * height assertion that only holds for the short one proves very little. Both states are
 * faked at the HTTP boundary with `page.route`, so local Google credentials cannot decide
 * which markup the test measures. Real Drive is never contacted.
 */

/**
 * Pixels below the card's content that neither its padding nor its last child's margin
 * accounts for. Zero, give or take sub-pixel rounding, on a card sized by its content.
 */
const unexplainedSpaceBelowContent = (card: Locator) =>
  card.evaluate((element) => {
    const last = element.lastElementChild;
    if (!last) throw new Error('the card has no content to measure against');
    const gap = element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
    const padding = parseFloat(getComputedStyle(element).paddingBottom);
    const margin = parseFloat(getComputedStyle(last).marginBottom);
    return Math.round(gap - padding - margin);
  });

const heightOf = (card: Locator) =>
  card.evaluate((element) => Math.round(element.getBoundingClientRect().height));

/** The Drive card before Google OAuth credentials have been configured. */
const serveUnconfiguredDrive = (page: Page) =>
  page.route('**/api/settings/drive', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: false,
        connected: false,
        rootFolderId: null,
        rootFolderUrl: null,
      }),
    }),
  );

test('the Settings cards size to their content at desktop width, in both Drive states', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const layout = page.locator('.settings-layout');
  const cards = layout.locator('.settings-card');
  const drive = cards.first();
  const branding = cards.filter({
    has: page.getByRole('heading', { level: 2, name: 'Branding' }),
  });

  // 1. Disconnected without credentials — the state every install starts in, and the state the
  //    blank area was first reported against.
  await serveUnconfiguredDrive(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(drive.getByRole('heading', { level: 2, name: 'Google Drive' })).toBeVisible();
  // The credentials warning belongs to this state and is part of what the card sizes around.
  await expect(drive.getByText('Credentials required')).toBeVisible();

  expect(await unexplainedSpaceBelowContent(drive)).toBeLessThanOrEqual(2);

  // The card no longer takes its height from the two cards beside it. Branding carries the long
  // colour form and is far taller; before this fix the Drive card matched it and then some.
  const brandingHeight = await heightOf(branding);
  const disconnectedHeight = await heightOf(drive);
  expect(disconnectedHeight).toBeLessThan(brandingHeight);

  // Every card in the grid sizes to its content, not to its row. The Drive card was the
  // reported one; the rule that fixed it is the layout's, so the whole layout is checked.
  await expect(cards).toHaveCount(8);
  for (const card of await cards.all()) {
    expect(await unexplainedSpaceBelowContent(card)).toBeLessThanOrEqual(2);
  }

  // 2. Connected with a root folder set — a few hundred pixels taller, same guarantee.
  await page.route('**/api/settings/drive', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        connected: true,
        rootFolderId: 'e2e-root-folder-id',
        rootFolderUrl: 'https://drive.google.com/drive/folders/e2e-root-folder-id',
      }),
    }),
  );
  await page.goto('/settings');
  await expect(drive.getByRole('button', { name: 'Disconnect Google Drive' })).toBeVisible();
  await expect(drive.getByText('Current root folder')).toBeVisible();
  await expect(drive.getByText('Credentials required')).toHaveCount(0);

  const connectedHeight = await heightOf(drive);
  expect(await unexplainedSpaceBelowContent(drive)).toBeLessThanOrEqual(2);
  // The card grew with its content. Two states this different rendering at one height would
  // mean something other than the content was setting it — the bug this spec exists for.
  expect(connectedHeight).toBeGreaterThan(disconnectedHeight);
  expect(connectedHeight).toBeLessThan(brandingHeight);

  // 3. Below 1100px the layout is one column, and it keeps the same guarantee.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(layout).toHaveCSS('grid-template-columns', /^[\d.]+px$/);
  expect(await unexplainedSpaceBelowContent(drive)).toBeLessThanOrEqual(2);
  expect(await heightOf(drive)).toBeGreaterThan(0);
});

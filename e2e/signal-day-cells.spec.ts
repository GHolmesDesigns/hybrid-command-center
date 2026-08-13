import { test, expect } from '@playwright/test';

/**
 * The Wave 1 spec for C38. The claim the card is about — that a day cell is the same height
 * whatever is in it — is invisible to every other check in this repository. jsdom has no
 * layout engine, so a unit test can assert that a long post is previewed and never notice
 * that the browser drew its cell, and every cell in that week, twice as tall as the rest.
 * Only a real browser settles it, and only by measuring.
 *
 * The month is far in the future and used by no other spec, so the cells measured here hold
 * only what this run put in them; the suite shares one database.
 */
const MONTH = '2099-05';
const LONG_DAY = '2099-05-06';
const SHORT_DAY = '2099-05-21';

/** A post the length the campaign content actually runs to. */
const LONG = `A thousand-character post ${'with durable copy '.repeat(70)}and a closing line.`;

test('a Signal day cell keeps its height whatever its posts hold', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = Date.now();
  const shortText = `E2E short post ${run}`;

  for (const data of [
    { text: LONG, date: LONG_DAY },
    { text: shortText, date: SHORT_DAY },
  ]) {
    const created = await page.request.post('/api/signal/posts', {
      data: { ...data, time: '09:00', status: 'SCHEDULED' },
    });
    expect(created.ok()).toBe(true);
  }

  await page.goto(`/signal?month=${MONTH}`);
  await expect(page.getByRole('heading', { level: 2, name: 'May 2099' })).toBeVisible();
  // The web fonts are an @import, and swapping one in re-lays out every heading above the grid.
  // Settled before anything is measured, so a font arriving late cannot move the page mid-run.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const cells = page.locator('.signal-grid > .signal-day');
  const heights = () =>
    cells.evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().height)),
    );

  /**
   * Where each cell sits in the grid, measured from the first cell rather than from the
   * viewport. "Expanding moves no other cell" is a claim about the cells' positions relative
   * to each other; against the viewport it would also fail on anything that shifted the whole
   * page, which is a different thing and not what this spec is for.
   */
  const boxes = () =>
    cells.evaluateAll((elements) => {
      const origin = elements[0]?.getBoundingClientRect();
      if (!origin) throw new Error('the month has no cells to measure');
      return elements.map((element) => {
        const box = element.getBoundingClientRect();
        const top = Math.round(box.top - origin.top);
        return `${top}:${Math.round(box.left - origin.left)}:${Math.round(box.height)}`;
      });
    });

  // 1. Every cell in the month is one height — the cell holding the long post included.
  const before = await heights();
  expect(before.length).toBeGreaterThan(30);
  expect(new Set(before).size).toBe(1);

  // Scoped to one post rather than to the day: the suite shares a database, and this spec is
  // about the post it created, not about everything that has ever been given that date.
  const long = page.getByRole('region', { name: LONG_DAY }).locator('.signal-post').first();
  const body = long.locator('.signal-post-text');
  await expect(body).toHaveText(/…$/);
  await expect(body).not.toHaveText(LONG);

  // 2. Expanding shows the whole post and moves nothing: not its own cell, not its neighbours.
  const boxesBefore = await boxes();
  await long.getByRole('button', { name: /^Show more of/ }).click();
  await expect(body).toHaveText(LONG);
  expect(await boxes()).toEqual(boxesBefore);

  await long.getByRole('button', { name: /^Show less of/ }).click();
  await expect(body).toHaveText(/…$/);

  // 3. Expand and edit are two controls, separately reachable and neither triggering the other.
  const edit = long.getByRole('button', { name: /^Edit A thousand-character post/ });
  const expand = long.getByRole('button', { name: /^Show more of/ });
  await edit.focus();
  await page.keyboard.press('Tab');
  await expect(expand).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(long.getByRole('button', { name: /^Show less of/ })).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('heading', { level: 2, name: 'Edit post' })).toBeVisible();
  await expect(editor.getByLabel('Content')).toHaveValue(LONG);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 4. A post short enough to show whole is shown whole, with no control that would do nothing.
  const short = page
    .getByRole('region', { name: SHORT_DAY })
    .locator('.signal-post')
    .filter({ hasText: shortText });
  await expect(short.locator('.signal-post-text')).toHaveText(shortText);
  await expect(short.getByRole('button', { name: /^Show more/ })).toHaveCount(0);

  // The heights the month started with are the heights it ends with.
  expect(await heights()).toEqual(before);
});

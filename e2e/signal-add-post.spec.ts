import { test, expect } from '@playwright/test';

/**
 * Wave 17 / C99: one Add Post flow from day cells and top navigation.
 *
 * What only a browser settles is that the day-cell plus, the queue action, and the top bar all
 * open the same form, that a cell's YYYY-MM-DD date survives into the saved post, and that
 * closing clears `new` without dropping the month.
 */
const MONTH = '2099-08';
const DAY = '2099-08-12';

test('Signal Add Post entry points share one form and preserve the cell date', async ({ page }) => {
  const run = Date.now();
  const datedText = `E2E dated Add Post ${run}`;
  const queueText = `E2E unscheduled Add Post ${run}`;

  await page.goto(`/signal?month=${MONTH}`);
  await expect(page.getByRole('heading', { level: 2, name: 'August 2099' })).toBeVisible();

  await page.getByRole('button', { name: `Add post on ${DAY}` }).click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByRole('heading', { name: 'Add post' })).toBeVisible();
  await expect(editor.getByLabel('Date')).toHaveValue(DAY);
  await expect(page).toHaveURL(new RegExp(`[?&]new=${DAY}`));

  await editor.getByLabel('Content').fill(datedText);
  await editor.getByRole('button', { name: 'Add post' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]new=/);
  await expect(page).toHaveURL(new RegExp(`[?&]month=${MONTH}`));
  await expect(page.getByRole('region', { name: DAY })).toContainText(datedText);

  await page.getByRole('button', { name: 'Add post' }).first().click();
  await expect(page.getByRole('dialog').getByLabel('Date')).toHaveValue('');
  await expect(page).toHaveURL(/[?&]new=1/);
  await page.getByRole('dialog').getByLabel('Content').fill(queueText);
  await page.getByRole('dialog').getByRole('button', { name: 'Add post' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: /Unscheduled queue/i })).toContainText(
    queueText,
  );

  await page
    .getByRole('region', { name: DAY })
    .getByRole('button', { name: `Add post on ${DAY}` })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close editor' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]new=/);
  await expect(page).toHaveURL(new RegExp(`[?&]month=${MONTH}`));
});

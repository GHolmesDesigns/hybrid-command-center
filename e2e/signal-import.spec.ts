import { test, expect } from '@playwright/test';

test('a Signal queue previews, imports, and reports a safe re-import', async ({ page }) => {
  const run = Date.now();
  const text = `Signal import browser flow ${run}`;
  const workbook = [
    '[SignalPosts]',
    'post_key\ttext\tdate\ttime\tstatus',
    `POST-E2E\t${text}\t2099-10-01\t13:00\tSCHEDULED`,
    '[SignalMedia]',
    'post_key\tmedia_order\tsource\turl',
    `POST-E2E\t1\tURL\thttps://example.com/${run}.jpg`,
  ].join('\n');

  await page.goto('/import');
  await page.getByRole('button', { name: 'Import Signal queue' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Or paste the tabs').fill(workbook);
  await dialog.getByRole('button', { name: 'Check Signal import' }).click();
  await expect(dialog.getByText('Ready to import')).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 records' }).click();
  await expect(dialog.getByText('Imported 2 records')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Import Signal queue' }).click();
  const second = page.getByRole('dialog');
  await second.getByLabel('Or paste the tabs').fill(workbook);
  await second.getByRole('button', { name: 'Check Signal import' }).click();
  await expect(second.getByText('0 updates, 2 fallback skips.')).toBeVisible();
  await second.getByRole('button', { name: 'Import 0 records' }).click();
  await expect(second.getByText('Imported 0 records')).toBeVisible();
});

import { test, expect } from '@playwright/test';
import { gotoSettled } from './ready';

/**
 * C100 / issue #299: configured default views survive a reload, and an explicit URL still wins.
 *
 * Settings writes the preference; a clean `/projects` navigation must land on that sort; a
 * bookmarked `?sort=` must override it; Reset + Save restores the shipped default.
 */
test('Projects sort default applies on a clean URL, yields to an explicit sort, and resets', async ({
  page,
}) => {
  const original = (await (await page.request.get('/api/settings/view-defaults')).json())
    .viewDefaults;
  const viewsCard = page
    .locator('.settings-card')
    .filter({ has: page.getByRole('heading', { name: 'Default views' }) });
  const sortDefault = page.getByLabel('Projects sort default');
  const save = page.getByRole('button', { name: 'Save defaults' });
  const projectsSort = () => page.getByRole('combobox', { name: 'Sort projects by' });

  try {
    await gotoSettled(page, '/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(viewsCard.getByRole('heading', { name: 'Default views' })).toBeVisible();

    await sortDefault.selectOption('name-ascending');
    await save.click();
    await expect(page.getByText('Default views saved.')).toBeVisible();

    await gotoSettled(page, '/projects');
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    await expect(projectsSort()).toHaveValue('name-ascending');
    await expect(page).toHaveURL(/\/projects\/?$/);

    await gotoSettled(page, '/projects?sort=name-descending');
    await expect(projectsSort()).toHaveValue('name-descending');
    await expect(page).toHaveURL(/sort=name-descending/);

    await gotoSettled(page, '/settings');
    await viewsCard.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(sortDefault).toHaveValue('recently-updated');
    await save.click();
    await expect(page.getByText('Default views saved.')).toBeVisible();

    await gotoSettled(page, '/projects');
    await expect(projectsSort()).toHaveValue('recently-updated');
  } finally {
    await page.request.put('/api/settings/view-defaults', { data: original });
  }
});

import { test, expect } from '@playwright/test';
import { gotoSettled } from './ready';
import {
  CANONICAL_VIEW_DEFAULTS,
  type ViewDefaults,
} from '../shared/view-defaults';

/**
 * C100 / issue #299: configured default views survive a reload, and an explicit URL still wins.
 *
 * The preference is written through Settings so the form path is exercised; a clean `/projects`
 * navigation must land on that sort; a bookmarked `?sort=` must override it; Reset + Save restores
 * the shipped default. Windows CI pays for several font-settled navigations, so the budget is
 * wider than the default 30s.
 */
test('Projects sort default applies on a clean URL, yields to an explicit sort, and resets', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const original = (await (await page.request.get('/api/settings/view-defaults')).json())
    .viewDefaults as ViewDefaults;
  const viewsCard = page
    .locator('.settings-card')
    .filter({ has: page.getByRole('heading', { name: 'Default views' }) });
  const sortDefault = () => page.getByLabel('Projects sort default');
  const save = () => page.getByRole('button', { name: 'Save defaults' });
  const projectsSort = () => page.getByRole('combobox', { name: 'Sort projects by' });

  try {
    await gotoSettled(page, '/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(viewsCard.getByRole('heading', { name: 'Default views' })).toBeVisible();

    await sortDefault().selectOption('name-ascending');
    await save().click();
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
    await expect(sortDefault()).toHaveValue(CANONICAL_VIEW_DEFAULTS.projects.sort);
    await save().click();
    await expect(page.getByText('Default views saved.')).toBeVisible();

    await gotoSettled(page, '/projects');
    await expect(projectsSort()).toHaveValue(CANONICAL_VIEW_DEFAULTS.projects.sort);
  } finally {
    await page.request
      .put('/api/settings/view-defaults', { data: original, timeout: 15_000 })
      .catch(() => undefined);
  }
});

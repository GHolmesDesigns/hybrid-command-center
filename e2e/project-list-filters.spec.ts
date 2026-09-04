import { test, expect } from '@playwright/test';
import { gotoSettled } from './ready';

/**
 * C101 / issue #300: Projects grid/list presentation and live-status filters share one result
 * set, keep durable state in the address, and clear status filters when Archived is chosen so
 * the two scopes cannot contradict silently.
 *
 * Every name is stamped with the run and every assertion is scoped to rows this spec created,
 * because the suite shares one database.
 */
test('Projects list presentation and live-status filters survive reload and stay consistent', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `E2E Rows Client ${run}` } })
  ).json();
  const nameFor = (status: string) => `E2E Rows ${status} ${run}`;
  for (const status of ['PLANNING', 'BUILDING', 'ACTIVE', 'ON_HOLD'] as const) {
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: nameFor(status), status },
    });
  }

  const presentation = page.getByRole('group', { name: 'Project presentation' });
  const visibility = page.getByRole('group', { name: 'Project visibility' });
  const statusFilter = page.getByRole('group', { name: 'Status' });

  await gotoSettled(page, `/projects?client=${client.id}&statuses=ACTIVE,PLANNING,BUILDING`);
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: nameFor('PLANNING') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: nameFor('ACTIVE') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: nameFor('BUILDING') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: nameFor('ON_HOLD') })).toHaveCount(0);

  await presentation.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page).toHaveURL(/view=list/);
  await expect(
    page.locator('.project-row-link strong', { hasText: nameFor('PLANNING') }),
  ).toBeVisible();
  await expect(
    page.locator('.project-row-link strong', { hasText: nameFor('ACTIVE') }),
  ).toBeVisible();
  await expect(
    page.locator('.project-row-link strong', { hasText: nameFor('BUILDING') }),
  ).toBeVisible();
  await expect(
    page.locator('.project-row-link strong', { hasText: nameFor('ON_HOLD') }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('article.project-row')
      .filter({ hasText: nameFor('ACTIVE') })
      .getByRole('link', { name: 'Open board' }),
  ).toBeVisible();

  await page.reload();
  await expect(presentation.getByRole('button', { name: 'List', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(statusFilter.getByRole('button', { name: 'Active', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(statusFilter.getByRole('button', { name: 'Planning', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator('.project-row-link strong', { hasText: nameFor('ACTIVE') }),
  ).toBeVisible();

  await visibility.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(page).not.toHaveURL(/statuses=/);
  await expect(statusFilter.getByRole('button', { name: 'Active', exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      'Status filters apply to live projects. Switch to Live or All to narrow by planning status.',
    ),
  ).toBeVisible();

  await visibility.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sort projects by' }).selectOption('custom');
  await expect(
    page.getByText('Custom order is kept, but rearranging by hand is available in Grid view only.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Drag / })).toHaveCount(0);
});

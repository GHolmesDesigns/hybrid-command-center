import { test, expect } from '@playwright/test';

/**
 * The Stage 3 spec for C14. What only a real browser and a real database can settle is that a
 * category typed on one project is the same row when reused on another, that the filter lives
 * in the page address rather than in React state, and that renaming or deleting the category
 * reaches every project at once without taking a project with it.
 *
 * Every name is stamped with the run, and every count is scoped to the rows this spec created,
 * because the suite shares one database.
 */
test('project categories are shared, filterable through the address, and safe to rename', async ({
  page,
}) => {
  const run = Date.now(),
    clientName = `E2E Categories Client ${run}`,
    retainerProject = `E2E Retainer ${run}`,
    campaignProject = `E2E Campaign ${run}`,
    retainer = `E2E Retainer label ${run}`,
    renamedRetainer = `E2E Ongoing label ${run}`,
    campaign = `E2E Campaign label ${run}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  const newProject = async (name: string, categories: string[]) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: /New project/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="clientId"]').selectOption(client.id);
    await dialog.getByLabel('Project name').fill(name);
    for (const category of categories) {
      await dialog.getByLabel('Add a category').fill(category);
      await dialog.getByLabel('Add a category').press('Enter');
    }
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText('Project created.', { exact: false })).toBeVisible();
    const projects = await (await page.request.get('/api/projects')).json();
    return projects.find((project: { name: string }) => project.name === name);
  };

  const first = await newProject(retainerProject, [retainer]);
  expect(first.categories.map((category: { name: string }) => category.name)).toEqual([retainer]);

  // The second project types the same name in a different case: one category, two projects.
  const second = await newProject(campaignProject, [campaign, retainer.toUpperCase()]);
  const categories = await (await page.request.get('/api/categories')).json();
  const shared = categories.filter((category: { name: string }) =>
    [retainer, campaign].includes(category.name),
  );
  expect(shared).toHaveLength(2);
  const retainerId = shared.find((category: { name: string }) => category.name === retainer).id;
  expect(second.categories.map((category: { id: string }) => category.id)).toContain(retainerId);

  // Filtering by address alone, which is what a reload and a shared link both come back to.
  await page.goto(`/projects?categories=${retainerId}`);
  await expect(page.getByRole('heading', { level: 2, name: retainerProject })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: campaignProject })).toBeVisible();
  await page
    .getByRole('group', { name: 'Categories' })
    .getByRole('button', { name: campaign, exact: true })
    .click();
  // Both categories now required, so only the project carrying both is left.
  await expect(page.getByRole('heading', { level: 2, name: retainerProject })).toBeHidden();
  await expect(page.getByRole('heading', { level: 2, name: campaignProject })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: retainerProject })).toBeHidden();
  await expect(page.getByRole('heading', { level: 2, name: campaignProject })).toBeVisible();

  // One rename, both projects — the name lives on the category, not on the projects.
  await page.goto('/settings');
  await page.getByRole('button', { name: `Rename category ${retainer}` }).click();
  await page.getByLabel(`New name for ${retainer}`).fill(renamedRetainer);
  // Exact, or this also matches the branding card's Save button further up the page.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Category renamed to', { exact: false })).toBeVisible();
  const renamed = await (await page.request.get('/api/projects')).json();
  for (const id of [first.id, second.id])
    expect(
      renamed
        .find((project: { id: string }) => project.id === id)
        .categories.map((category: { name: string }) => category.name),
    ).toContain(renamedRetainer);

  // Deleting an attached category detaches it and leaves both projects standing.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `Delete category ${renamedRetainer}` }).click();
  await expect(page.getByText('deleted from 2 projects', { exact: false })).toBeVisible();
  const afterDelete = await (await page.request.get('/api/projects')).json();
  for (const id of [first.id, second.id]) {
    const project = afterDelete.find((candidate: { id: string }) => candidate.id === id);
    expect(project).toBeTruthy();
    expect(project.categories.map((category: { name: string }) => category.name)).not.toContain(
      renamedRetainer,
    );
  }
  expect(
    (await (await page.request.get('/api/categories')).json()).some(
      (category: { name: string }) => category.name === renamedRetainer,
    ),
  ).toBe(false);
});

import { test, expect } from '@playwright/test';
import { addDays, format } from 'date-fns';

test('a dashboard deadline tile opens the board filtered to the tasks it counted', async ({
  page,
}) => {
  const run = Date.now(),
    clientName = `Tile Client ${run}`,
    projectName = `Tile Launch ${run}`,
    dueTodayTitle = `Tile due today ${run}`,
    dueLaterTitle = `Tile due later ${run}`;
  // Set up through the API. What this flow is about is the tile and the board it reaches;
  // building the rows through the forms is what the critical-flow spec already covers.
  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', { data: { clientId: client.id, name: projectName } })
  ).json();
  for (const [title, dueDate] of [
    [dueTodayTitle, format(new Date(), 'yyyy-MM-dd')],
    [dueLaterTitle, format(addDays(new Date(), 5), 'yyyy-MM-dd')],
  ])
    await page.request.post('/api/tasks', { data: { projectId: project.id, title, dueDate } });

  const { counts } = await (await page.request.get('/api/dashboard')).json();
  expect(counts.dueToday).toBeGreaterThan(0);
  await page.goto('/');
  // The number is part of the tile's name, so finding it by name is already the assertion
  // that the tile shows the count the API reports.
  await page.getByRole('link', { name: `Due today: ${counts.dueToday}` }).click();
  await expect(page).toHaveURL(/\/status\?filter=today$/);
  await expect(page.getByLabel('Focus')).toHaveValue('today');
  // The round trip closes here: the tile counted with one rule and the board filters with the
  // same one, so the card count and the tile's figure cannot disagree.
  await expect(page.locator('.kanban-card')).toHaveCount(counts.dueToday);
  await expect(page.getByText(dueTodayTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(dueLaterTitle, { exact: true })).toHaveCount(0);

  await page.goBack();
  await page.getByRole('link', { name: `Next 7 days: ${counts.dueNextSevenDays}` }).click();
  await expect(page).toHaveURL(/\/status\?filter=week$/);
  await expect(page.getByLabel('Focus')).toHaveValue('week');
  await expect(page.locator('.kanban-card')).toHaveCount(counts.dueNextSevenDays);
  // The week window includes today, so the tighter tile's task is still here beside this one.
  await expect(page.getByText(dueLaterTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(dueTodayTitle, { exact: true })).toBeVisible();
});

test('the old /kanban address redirects to /status with its filters intact', async ({ page }) => {
  await page.goto('/kanban?filter=today');
  await expect(page).toHaveURL(/\/status\?filter=today$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
  await expect(page.getByLabel('Focus')).toHaveValue('today');
});

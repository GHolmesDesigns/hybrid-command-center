import { test, expect } from '@playwright/test';
import { addDays, format, subDays } from 'date-fns';

test('critical project workflow is visible and interactive', async ({ page }) => {
  const run = Date.now(),
    clientName = `E2E Client ${run}`,
    projectName = `E2E Launch ${run}`,
    foundationTitle = `E2E foundation ${run}`,
    blockedTitle = `E2E blocked ${run}`;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your work, in focus.' })).toBeVisible();
  await page.getByRole('button', { name: 'New client' }).first().click();
  await page.getByLabel('Client name').fill(clientName);
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByText('Client created.', { exact: false })).toBeVisible();
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const clients = await (await page.request.get('/api/clients')).json();
  const clientId = clients.find((client: { name: string }) => client.name === clientName).id;
  const projectDialog = page.getByRole('dialog');
  await projectDialog.locator('select[name="clientId"]').selectOption(clientId);
  await projectDialog.getByLabel('Project name').fill(projectName);
  await projectDialog.getByRole('button', { name: 'Create project' }).click();
  await page.goto('/kanban');
  await page.getByRole('button', { name: 'New task' }).first().click();
  const projects = await (await page.request.get('/api/projects')).json();
  const projectId = projects.find((project: { name: string }) => project.name === projectName).id;
  let taskDialog = page.getByRole('dialog');
  await taskDialog.locator('select[name="projectId"]').selectOption(projectId);
  await taskDialog.getByLabel('Task title').fill(foundationTitle);
  await taskDialog.getByLabel('Due date').fill(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  await taskDialog.getByRole('button', { name: 'Create task' }).click();
  await page.goto(`/kanban?project=${projectId}`);
  await expect(page.getByText(foundationTitle, { exact: true })).toBeVisible();
  await page.getByText(foundationTitle, { exact: true }).click();
  await page.getByPlaceholder('Add a checklist item').fill('Confirm foundation');
  await page.getByRole('button', { name: 'Add' }).first().click();
  await expect(page.getByText('Confirm foundation')).toBeVisible();
  await page.getByRole('dialog').locator('footer').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'New task' }).first().click();
  taskDialog = page.getByRole('dialog');
  await taskDialog.locator('select[name="projectId"]').selectOption(projectId);
  await taskDialog.getByLabel('Task title').fill(blockedTitle);
  await taskDialog.getByLabel('Due date').fill(format(subDays(new Date(), 1), 'yyyy-MM-dd'));
  await taskDialog.getByRole('button', { name: 'Create task' }).click();
  await page.getByText(blockedTitle, { exact: true }).click();
  const dependencySection = page
    .getByRole('dialog')
    .locator('section')
    .filter({ hasText: 'Dependencies' });
  const currentTasks = await (await page.request.get('/api/tasks')).json();
  const foundationId = currentTasks.find(
    (task: { title: string; projectId: string }) =>
      task.title === foundationTitle && task.projectId === projectId,
  ).id;
  await dependencySection.locator('select').selectOption(foundationId);
  await dependencySection.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('dialog').getByText('Waiting on 1 task')).toBeVisible();
  await page.getByRole('dialog').locator('footer').getByRole('button', { name: 'Close' }).click();
  const blockedCard = page.locator('.kanban-card').filter({ hasText: blockedTitle });
  await expect(blockedCard.locator('.blocked-label')).toBeVisible();
  const foundationCard = page.locator('.kanban-card').filter({ hasText: foundationTitle });
  await foundationCard.locator('.keyboard-move select').selectOption('IN_PROGRESS');
  await expect(
    page
      .locator('.kanban-column')
      .filter({ hasText: 'In Progress' })
      .getByText(foundationTitle, { exact: true }),
  ).toBeVisible();
  const dashboard = await (await page.request.get('/api/dashboard')).json();
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: new RegExp(`^${dashboard.counts.overdue} overdue task`) }),
  ).toBeVisible();
});

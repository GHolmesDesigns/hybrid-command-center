import { test, expect } from '@playwright/test';
import { addDays, format, subDays } from 'date-fns';

test('critical project workflow is visible and interactive', async ({ page }) => {
  const run = Date.now(),
    clientName = `E2E Client ${run}`,
    projectName = `E2E Launch ${run}`,
    foundationTitle = `E2E foundation ${run}`,
    blockedTitle = `E2E blocked ${run}`,
    tagName = `E2E tag ${run}`;
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
  await page.goto('/status');
  await page.getByRole('button', { name: 'New task' }).first().click();
  const projects = await (await page.request.get('/api/projects')).json();
  const projectId = projects.find((project: { name: string }) => project.name === projectName).id;
  let taskDialog = page.getByRole('dialog');
  await taskDialog.locator('select[name="projectId"]').selectOption(projectId);
  await taskDialog.getByLabel('Task title').fill(foundationTitle);
  await taskDialog.getByLabel('Due date').fill(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
  await taskDialog.getByRole('button', { name: 'Create task' }).click();
  await page.goto(`/status?project=${projectId}`);
  await expect(page.getByText(foundationTitle, { exact: true })).toBeVisible();
  await page.getByText(foundationTitle, { exact: true }).click();
  // Each detail section owns an Add control, so every one of them is scoped by section.
  const checklistSection = page
    .getByRole('dialog')
    .locator('section')
    .filter({ hasText: 'Checklist' });
  await checklistSection.getByPlaceholder('Add a checklist item').fill('Confirm foundation');
  await checklistSection.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Confirm foundation')).toBeVisible();
  const tagSection = page.getByRole('dialog').locator('section').filter({ hasText: 'Tags' });
  await tagSection.getByLabel('Add a tag').fill(`  ${tagName}  `);
  await tagSection.getByLabel('Add a tag').press('Enter');
  await expect(page.getByRole('button', { name: `Remove tag ${tagName}` })).toBeVisible();
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
  const blockedId = currentTasks.find(
    (task: { title: string; projectId: string }) =>
      task.title === blockedTitle && task.projectId === projectId,
  ).id;
  await dependencySection.locator('select').selectOption(foundationId);
  await dependencySection.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('dialog').getByText('Waiting on 1 task')).toBeVisible();
  await page.getByRole('dialog').locator('footer').getByRole('button', { name: 'Close' }).click();
  const blockedCard = page.locator('.kanban-card').filter({ hasText: blockedTitle });
  await expect(blockedCard.locator('.blocked-label')).toBeVisible();
  const foundationCard = page.locator('.kanban-card').filter({ hasText: foundationTitle });
  let reorderPayload: { taskId: string; status: string; orderedIds: string[] } | undefined;
  let finishReorder!: () => void;
  const reorderFinished = new Promise<void>((resolve) => {
    finishReorder = resolve;
  });
  await page.route('**/api/tasks/reorder', async (route) => {
    try {
      reorderPayload = route.request().postDataJSON();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    } finally {
      finishReorder();
    }
  });
  const dragHandle = blockedCard.getByRole('button', { name: `Drag ${blockedTitle}` });
  await dragHandle.hover();
  const source = await dragHandle.boundingBox();
  if (!source) throw new Error('Expected the task drag handle to have a bounding box.');
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2, {
    steps: 5,
  });
  await expect(dragHandle).toHaveAttribute('aria-pressed', 'true');
  const target = await foundationCard.boundingBox();
  if (!target) throw new Error('Expected the reorder target to have a bounding box.');
  await page.mouse.move(target.x + target.width / 2, target.y + 10, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(() => reorderPayload)
    .toEqual({
      taskId: blockedId,
      status: 'BACKLOG',
      orderedIds: [blockedId, foundationId],
    });
  await expect(
    page
      .locator('.kanban-column')
      .filter({ hasText: 'Backlog' })
      .locator('.kanban-card .card-title strong'),
  ).toHaveText([blockedTitle, foundationTitle]);
  await reorderFinished;
  await expect(page.getByText('Reordered in Backlog.', { exact: true })).toBeVisible();
  await page.unroute('**/api/tasks/reorder');
  await page.reload();
  await expect(
    page
      .locator('.kanban-column')
      .filter({ hasText: 'Backlog' })
      .locator('.kanban-card .card-title strong'),
  ).toHaveText([blockedTitle, foundationTitle]);
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
  // The tag survived every reload above and reads as text on the card, not colour alone.
  await page.goto(`/status?project=${projectId}`);
  await expect(foundationCard.getByText(tagName, { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search' }).fill(tagName);
  await expect(page.locator('.kanban-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('group', { name: 'Tags' }).getByRole('button', { name: tagName }).click();
  await expect(page.locator('.kanban-card')).toHaveCount(1);
  await expect(page.locator('.kanban-card')).toContainText(foundationTitle);
});

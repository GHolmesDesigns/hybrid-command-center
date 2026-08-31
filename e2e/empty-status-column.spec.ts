import { test, expect } from '@playwright/test';

test('drops a task into an empty status column and persists the status', async ({ page }) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `E2E Empty Column Client ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `E2E Empty Column Project ${run}`, status: 'ACTIVE' },
    })
  ).json();
  const task = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: `E2E Empty Column Task ${run}`, status: 'BACKLOG' },
    })
  ).json();

  await page.goto(`/status?project=${project.id}`);
  const card = page.locator('.kanban-card').filter({ hasText: task.title });
  const targetColumn = page
    .locator('.kanban-column')
    .filter({ has: page.getByRole('heading', { name: 'In Progress', exact: true }) });
  await expect(card).toBeVisible();
  await expect(targetColumn.locator('.kanban-card')).toHaveCount(0);

  const handle = card.getByRole('button', { name: `Drag ${task.title}` });
  await handle.hover();
  const source = await handle.boundingBox();
  const target = await targetColumn.locator('.column-body').boundingBox();
  if (!source || !target) throw new Error('Expected drag source and empty column body bounds.');

  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 20, source.y + source.height / 2, {
    steps: 5,
  });
  await expect(card).toHaveClass(/dragging/);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const response = await page.request.get('/api/tasks');
      return (await response.json()).find((candidate: { id: string }) => candidate.id === task.id);
    })
    .toMatchObject({ status: 'IN_PROGRESS' });
  await page.reload();
  await expect(
    page
      .locator('.kanban-column')
      .filter({ has: page.getByRole('heading', { name: 'In Progress', exact: true }) })
      .getByText(task.title, { exact: true }),
  ).toBeVisible();

  await card.locator('.keyboard-move select').selectOption('COMPLETE');
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/tasks');
      return (await response.json()).find((candidate: { id: string }) => candidate.id === task.id);
    })
    .toMatchObject({ status: 'COMPLETE' });
});

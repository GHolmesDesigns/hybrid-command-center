import { test, expect } from '@playwright/test';

test('Tasks page lets an operator select a Project task and start Pomodoro focus', async ({
  page,
}) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Timer Client ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Timer Project ${run}` },
    })
  ).json();
  const task = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: `Focus task ${run}` },
    })
  ).json();

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  const taskButton = page.getByRole('button', { name: new RegExp(task.title) });
  await expect(taskButton).toBeVisible();
  await taskButton.click();
  await expect(page.getByText(`Working on ${task.title}`)).toBeVisible();
  await page.getByRole('button', { name: /^Start/ }).click();
  await expect(page.getByRole('button', { name: /^Pause/ })).toBeVisible();
  await page.getByRole('link', { name: 'Status' }).click();
  await expect(page).toHaveURL(/\/status$/);
});

test('Project Status Start Task selects a task without auto-starting the timer', async ({ page }) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Kanban Timer Client ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Kanban Timer Project ${run}` },
    })
  ).json();
  const task = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: `Kanban focus task ${run}` },
    })
  ).json();

  await page.goto('/status');
  await page.getByRole('button', { name: `Start Task for Kanban focus task ${run}` }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks\\?task=${task.id}`));
  await expect(page.getByText(`Working on Kanban focus task ${run}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Start/ })).toBeVisible();
  await page.getByRole('button', { name: /^Start/ }).click();
  await expect(page.getByRole('button', { name: /^Pause/ })).toBeVisible();
});

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
  await expect(page.getByRole('button', { name: new RegExp(task.title) })).toBeVisible();
  await expect(page.getByText(`Working on ${task.title}`)).toBeVisible();
  await page.getByRole('button', { name: /^Start/ }).click();
  await expect(page.getByRole('button', { name: /^Pause/ })).toBeVisible();
  await page.getByRole('link', { name: 'Status' }).click();
  await expect(page).toHaveURL(/\/status$/);
});

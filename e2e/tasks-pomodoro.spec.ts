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

test('Project Status Start Task selects a task without auto-starting the timer', async ({
  page,
}) => {
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

test('Start Task confirms before replacing another running session and cancel keeps it', async ({
  page,
}) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Conflict Client ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Conflict Project ${run}` },
    })
  ).json();
  const firstTask = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: `Running task ${run}` },
    })
  ).json();
  const secondTask = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: `Other task ${run}` },
    })
  ).json();

  await page.goto('/tasks');
  await page.getByRole('button', { name: new RegExp(firstTask.title) }).click();
  await page.getByRole('button', { name: /^Start/ }).click();
  await expect(page.getByRole('button', { name: /^Pause/ })).toBeVisible();

  await page.goto(`/tasks?task=${secondTask.id}`);
  await expect(page).toHaveURL(new RegExp(`/tasks\\?task=${secondTask.id}`));
  await expect(page.getByText(`Working on Other task ${run}`)).toBeVisible();
  await expect(page.getByRole('status')).toContainText(new RegExp(`Running task ${run}`));

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('Replace the timer for another task');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: /^Start/ }).click();
  await expect(page.getByRole('button', { name: /^Pause/ })).toBeHidden();
  await expect(page.getByRole('status')).toContainText(new RegExp(`Running task ${run}`));
});

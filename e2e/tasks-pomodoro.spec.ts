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

  await page.goto('/countdown');
  await expect(page.getByRole('heading', { level: 1, name: 'Countdown' })).toBeVisible();
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
  await expect(page).toHaveURL(new RegExp(`/countdown\\?task=${task.id}`));
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

  await page.goto('/countdown');
  const pomodoro = page.getByRole('region', { name: 'Pomodoro timer' });
  await page.getByRole('button', { name: new RegExp(firstTask.title) }).click();
  await pomodoro.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(pomodoro.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  await page.goto(`/countdown?task=${secondTask.id}`);
  await expect(page).toHaveURL(new RegExp(`/countdown\\?task=${secondTask.id}`));
  await expect(page.getByText(`Working on Other task ${run}`)).toBeVisible();
  await expect(pomodoro.getByRole('status')).toContainText(new RegExp(`Running task ${run}`));

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('Replace the timer for another task');
    await dialog.dismiss();
  });
  await pomodoro.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(pomodoro.getByRole('button', { name: 'Pause', exact: true })).toBeHidden();
  await expect(pomodoro.getByRole('status')).toContainText(new RegExp(`Running task ${run}`));
});

test('legacy task route redirects to Countdown and Settings exposes an accessible submenu', async ({
  page,
}) => {
  await page.goto('/tasks?filter=active');
  await expect(page).toHaveURL(/\/countdown\?filter=active$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Countdown' })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const topLevel = navigation.locator(':scope > a, :scope > .settings-nav-group > a');
  await expect(topLevel).toHaveCount(10);
  await expect(topLevel.nth(4)).toHaveText('Countdown');
  await expect(topLevel.nth(8)).toHaveText('Time');
  await expect(topLevel.nth(9)).toHaveText('Settings');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  const disclosure = navigation.getByRole('button', { name: 'Expand Settings pages' });
  await disclosure.focus();
  await disclosure.press('Enter');
  await expect(navigation.getByRole('button', { name: 'Collapse Settings pages' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  for (const label of ['Agents', 'Files', 'Health', 'Import']) {
    await expect(navigation.getByRole('link', { name: label })).toBeVisible();
  }
  const expandSidebar = page.getByRole('button', { name: 'Expand sidebar' });
  await expandSidebar.focus();
  await expandSidebar.press('Enter');
  await navigation.getByRole('link', { name: 'Health' }).click();
  await expect(page).toHaveURL(/\/health$/);
  await expect(navigation.getByRole('button', { name: 'Collapse Settings pages' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(navigation.getByRole('link', { name: 'Health' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

import { test, expect } from '@playwright/test';

test('global operator timer survives reloads, pauses and saves into project time', async ({
  page,
}) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Operator timer ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Timer project ${run}` },
    })
  ).json();
  const task = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: `Timer task ${run}` },
    })
  ).json();

  await page.goto('/');
  await page.getByRole('button', { name: 'Work timer' }).click();
  const panel = page.getByRole('region', { name: 'Work timer' });
  await panel.getByRole('combobox').nth(0).selectOption(project.id);
  await panel.getByRole('combobox').nth(2).selectOption(task.id);
  await panel.getByRole('button', { name: 'Start timer' }).click();
  await expect(panel.getByText('Running')).toBeVisible();
  await expect(panel.getByText(project.name)).toBeVisible();
  await expect(page).toHaveTitle(/HCC/);
  await page.reload();
  await page.getByRole('button', { name: /Running/ }).click();
  const reloaded = page.getByRole('region', { name: 'Work timer' });
  await expect(reloaded.getByText(task.title)).toBeVisible();
  await reloaded.getByRole('button', { name: 'Pause' }).click();
  await expect(reloaded.getByText('Paused')).toBeVisible();
  await page.waitForTimeout(1100);
  await reloaded.getByRole('button', { name: 'Resume' }).click();
  await expect(reloaded.getByText('Running')).toBeVisible();
  await page.waitForTimeout(1100);
  await reloaded.getByRole('button', { name: 'Stop and save' }).click();
  await expect(page.getByRole('button', { name: 'Work timer' })).toBeVisible();

  await page.goto(`/projects/${project.id}`);
  await page.getByRole('tab', { name: 'Time' }).click();
  const timePanel = page.getByRole('tabpanel', { name: 'Time' });
  const savedEntry = timePanel.locator('.time-entry');
  await expect(savedEntry.getByText(task.title)).toBeVisible();
  await expect(savedEntry.getByText('Timer entry')).toBeVisible();
});

test('discard requires a second in-page confirmation and writes no entry', async ({ page }) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Discard timer ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Discard project ${run}` },
    })
  ).json();
  await page.goto('/');
  await page.getByRole('button', { name: 'Work timer' }).click();
  const panel = page.getByRole('region', { name: 'Work timer' });
  await panel.getByRole('combobox').nth(0).selectOption(project.id);
  await panel.getByRole('button', { name: 'Start timer' }).click();
  await panel.getByRole('button', { name: 'Discard…' }).click();
  await expect(panel.getByRole('button', { name: 'Confirm discard' })).toBeVisible();
  await panel.getByRole('button', { name: 'Confirm discard' }).click();
  await expect(page.getByRole('button', { name: 'Work timer' })).toBeVisible();
  const entries = await page.request.get(`/api/projects/${project.id}/time/entries`);
  expect(await entries.json()).toEqual([]);
});

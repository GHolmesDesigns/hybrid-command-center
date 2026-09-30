import { test, expect } from '@playwright/test';
import { gotoSettled } from './ready';

test('deleting a project unassigns its Signal post and removes the project from workspace views', async ({
  page,
}) => {
  const run = Date.now();
  const clientName = `Delete Signal Client ${run}`;
  const projectName = `Delete Signal Project ${run}`;
  const postText = `Preserved Signal post ${run}`;
  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: projectName },
    })
  ).json();
  const created = await page.request.post('/api/signal/posts', {
    data: {
      clientId: client.id,
      projectId: project.id,
      text: postText,
      date: '2088-11-05',
      time: '13:00',
      channels: ['li'],
      status: 'SCHEDULED',
    },
  });
  expect(created.status()).toBe(201);
  const post = await created.json();

  await gotoSettled(page, '/projects?visibility=all');
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(page.getByText('1 Signal post will be unassigned, not deleted.')).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('1 Signal post will be unassigned, not deleted.');
    await dialog.accept();
  });
  await page.getByRole('button', { name: `Delete ${projectName}` }).click();
  await expect(
    page.getByText(
      'Project deleted from Command Center. 1 Signal post unassigned, not deleted. Drive files were left alone.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: projectName })).toHaveCount(0);

  const kept = await (await page.request.get(`/api/signal/posts/${post.id}`)).json();
  expect(kept).toMatchObject({
    id: post.id,
    projectId: null,
    text: postText,
    date: '2088-11-05',
    time: '13:00',
    revision: 2,
  });
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Clients' })
    .click();
  await page.getByRole('link', { name: clientName }).click();
  await expect(page.getByText(projectName)).toHaveCount(0);
});

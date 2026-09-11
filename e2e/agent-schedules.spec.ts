import { expect, test } from '@playwright/test';

test('operator manages a scheduled agent run and sees its handoff outcome', async ({
  page,
  request,
}) => {
  const create = await request.post('/api/agent-schedules', {
    data: {
      ownerAgentLabel: 'e2e-scheduler',
      subjectType: 'freeform',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      messageTemplate: 'E2E scheduled review.',
      dedupeKey: `e2e-${Date.now()}`,
    },
  });
  expect(create.ok()).toBeTruthy();

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Scheduled agent runs' })).toBeVisible();
  await expect(page.getByText('E2E scheduled review.')).toBeVisible();
  await page.getByRole('button', { name: 'Run due schedules' }).click();
  await expect(page.getByText(/1 due schedule ran/)).toBeVisible();
  await expect(page.getByText(/Last outcome: SUCCEEDED/)).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
});

import { expect, test } from '@playwright/test';

test('operator reads and clears an agent notification', async ({ page, request }) => {
  const create = await request.post('/api/agent-notifications', {
    data: {
      incidentKey: `e2e-notification-${Date.now()}`,
      kind: 'test',
      agentLabel: 'e2e-agent',
      title: 'E2E notification',
      body: 'A message for the operator.',
    },
  });
  expect(create.ok()).toBeTruthy();
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: /Notifications/ })).toBeVisible();
  await expect(page.getByText('E2E notification')).toBeVisible();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByText('No notifications match this filter.')).toBeVisible();
});

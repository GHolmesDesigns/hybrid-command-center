import { expect, test } from '@playwright/test';

/**
 * Wave 23 / C112: the operator coordination inbox.
 *
 * Agents post handoffs through the service (and MCP); the operator sees them under Settings,
 * opens one, and cancels with a required reason. Specs share one database, so every locator
 * and API assertion is scoped to the handoff this run created.
 */
test('operator can list a seeded handoff, follow its subject link, and cancel it', async ({
  page,
}) => {
  const stamp = Date.now();
  const clientName = `C112 client ${stamp}`;
  const projectName = `C112 project ${stamp}`;
  const taskTitle = `C112 task ${stamp}`;
  const message = `C112 handoff message ${stamp}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: projectName },
    })
  ).json();
  const task = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: taskTitle },
    })
  ).json();

  const created = await page.request.post('/api/agent-handoffs', {
    data: {
      fromAgentLabel: 'cursor',
      toAgentLabel: 'claude',
      subjectType: 'task',
      subjectId: task.id,
      message,
      clientRequestId: `c112-${stamp}`,
    },
  });
  expect(created.ok()).toBe(true);
  const handoff = await created.json();
  expect(handoff.state).toBe('OPEN');

  await page.goto('/agents');
  const panel = page.locator('.settings-card').filter({
    has: page.getByRole('heading', { level: 2, name: 'Agent handoffs' }),
  });
  await expect(panel.getByRole('heading', { level: 2, name: 'Agent handoffs' })).toBeVisible();

  const openGroup = panel.locator('.handoff-group').filter({
    has: page.getByRole('heading', { name: /Open/ }),
  });
  const row = openGroup.locator('.handoff-row').filter({ hasText: message });
  await expect(row).toBeVisible();
  await expect(row).toContainText('cursor');
  await expect(row).toContainText('claude');
  await expect(row.getByRole('link', { name: new RegExp(`Task: ${task.id}`) })).toHaveAttribute(
    'href',
    `/status?project=${project.id}`,
  );

  await row.click();
  const detail = panel.getByRole('region', { name: 'Handoff detail' });
  await expect(detail).toContainText(message);
  await expect(detail.getByLabel('Cancel reason')).toBeVisible();

  await detail.getByLabel('Cancel reason').fill('No longer needed for the Wave 23 e2e.');
  await detail.getByRole('button', { name: 'Cancel handoff' }).click();

  await expect(openGroup.locator('.handoff-row').filter({ hasText: message })).toHaveCount(0);
  const cancelledGroup = panel.locator('.handoff-group').filter({
    has: page.getByRole('heading', { name: /Cancelled \(7d\)/ }),
  });
  await expect(cancelledGroup.locator('.handoff-row').filter({ hasText: message })).toBeVisible();

  const reread = await page.request.get(`/api/agent-handoffs/${handoff.id}`);
  expect(await reread.json()).toMatchObject({
    state: 'CANCELLED',
    cancelReason: 'No longer needed for the Wave 23 e2e.',
  });

  // Specs share one database. Kanban reorder posts every BACKLOG id, not only the filtered
  // project, so a leftover task here breaks critical-flow's exact orderedIds assertion.
  expect((await page.request.delete(`/api/tasks/${task.id}`)).ok()).toBe(true);
});

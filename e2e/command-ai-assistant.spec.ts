import { test, expect } from '@playwright/test';

const openCommandAiDrawer = async (page: import('@playwright/test').Page) => {
  const drawer = page.getByRole('complementary', { name: 'Command AI' });
  if (await drawer.isVisible()) return drawer;
  const fab = page.getByRole('button', { name: 'Open Command AI' });
  if (await fab.count()) {
    await fab.click();
  } else {
    await page.getByRole('button', { name: 'Command AI' }).click();
  }
  await expect(drawer).toBeVisible();
  return drawer;
};

test('Command AI assistant streams a stub response and accepts an inline approval', async ({
  page,
}) => {
  const run = Date.now();
  const title = `Assistant E2E ${run}`;

  const enableAssistant = await page.request.put('/api/settings/command-ai-assistant', {
    data: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o-mini',
      scopes: ['workspace:read', 'workspace:write'],
    },
  });
  expect(enableAssistant.ok()).toBeTruthy();

  const liveTips = await page.request.put('/api/settings/agent-hub-live-tips', {
    data: { enabled: true },
  });
  expect(liveTips.ok()).toBeTruthy();

  const conversation = await (
    await page.request.post('/api/agent-conversations', {
      data: { title, scope: { type: 'freeform' } },
    })
  ).json();

  await page.goto('/');
  const drawer = await openCommandAiDrawer(page);
  await drawer.getByRole('button', { name: 'History' }).click();
  await drawer.getByRole('button', { name: new RegExp(title) }).click();

  await drawer.getByLabel('Command AI message').fill(`Trigger assistant ${run}`);
  await drawer.getByRole('button', { name: 'Send' }).click();

  await expect(drawer.getByLabel('Command AI streaming response')).toBeVisible({ timeout: 15_000 });
  await expect(drawer.getByText(/Hello from Command AI/)).toBeVisible({ timeout: 15_000 });

  await expect(drawer.getByText('workspace_add_checklist_item')).toBeVisible({ timeout: 15_000 });
  await drawer.getByRole('button', { name: 'Approve' }).click();

  await expect(drawer.getByText(/Approved workspace_add_checklist_item/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(drawer.getByLabel('Command AI streaming response')).toHaveCount(0);

  const messages = await (
    await page.request.get(`/api/agent-conversations/${conversation.id}/messages`)
  ).json();
  expect(
    (messages.items ?? []).some(
      (message: { senderKind?: string; body: string }) =>
        message.senderKind === 'assistant' && message.body.includes('Hello from Command AI'),
    ),
  ).toBeTruthy();
});

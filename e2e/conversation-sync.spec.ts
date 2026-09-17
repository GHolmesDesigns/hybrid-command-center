import { test, expect } from '@playwright/test';

// Open the drawer through its own control. `App` owns the open preference in localStorage and
// writes it back from an effect once it mounts behind `AuthGate`, so a test that writes the key
// and reloads races the app's own persistence (#678).
const openCommandAiDrawer = async (page: import('@playwright/test').Page) => {
  const drawer = page.getByRole('complementary', { name: 'Command AI' });
  if (await drawer.isVisible()) return;
  const fab = page.getByRole('button', { name: 'Open Command AI' });
  if (await fab.count()) {
    await fab.click();
  } else {
    await page.getByRole('button', { name: 'Command AI' }).click();
  }
  await expect(drawer).toBeVisible();
};

test('Command AI drawer and Conversations full view stay synchronized', async ({ page }) => {
  const run = Date.now();
  const liveTips = await page.request.put('/api/settings/agent-hub-live-tips', {
    data: { enabled: true },
  });
  expect(liveTips.ok()).toBeTruthy();

  const titleA = `Sync thread A ${run}`;
  const titleB = `Sync thread B ${run}`;
  const seedA = `Seed message A ${run}`;
  const seedB = `Seed message B ${run}`;

  const convA = await (
    await page.request.post('/api/agent-conversations', {
      data: { title: titleA, scope: { type: 'freeform' } },
    })
  ).json();
  const convB = await (
    await page.request.post('/api/agent-conversations', {
      data: { title: titleB, scope: { type: 'freeform' } },
    })
  ).json();
  await page.request.post(`/api/agent-conversations/${convA.id}/messages`, {
    data: { body: seedA },
  });
  await page.request.post(`/api/agent-conversations/${convB.id}/messages`, {
    data: { body: seedB },
  });

  const drawer = page.getByRole('complementary', { name: 'Command AI' });
  const detail = page.getByRole('region', { name: 'Conversation detail' });
  const list = page.getByRole('region', { name: 'Conversation list' });

  // Open conversation A in full view, then show conversation B in the drawer.
  await page.goto(`/agents/conversations?open=${encodeURIComponent(convA.id)}`);
  await expect(detail.getByRole('heading', { name: titleA })).toBeVisible();
  await expect(page.locator('.toast.error')).toHaveCount(0);
  await openCommandAiDrawer(page);
  await expect(detail.getByRole('heading', { name: titleA })).toBeVisible();
  await expect(detail.getByText(seedA)).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleA })).toBeVisible();

  await drawer.getByRole('button', { name: 'History' }).click();
  await drawer.getByRole('button', { name: new RegExp(titleB) }).click();
  await expect(page).toHaveURL(new RegExp(`open=${convB.id}`));
  await expect(detail.getByRole('heading', { name: titleB })).toBeVisible();
  await expect(detail.getByText(seedB)).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleB })).toBeVisible();

  // Selecting A from the drawer updates the URL, main detail, and drawer title together.
  await drawer.getByRole('button', { name: 'History' }).click();
  await drawer.getByRole('button', { name: new RegExp(titleA) }).click();
  await expect(page).toHaveURL(new RegExp(`open=${convA.id}`));
  await expect(detail.getByRole('heading', { name: titleA })).toBeVisible();
  await expect(detail.getByText(seedA)).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleA })).toBeVisible();

  const drawerMessage = `Drawer sync send ${run}`;
  await drawer.getByLabel('Command AI message').fill(drawerMessage);
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(detail.getByText(drawerMessage)).toHaveCount(1);

  await list.getByRole('button', { name: new RegExp(titleB) }).click();
  await expect(page).toHaveURL(new RegExp(`open=${convB.id}`));
  await expect(detail.getByRole('heading', { name: titleB })).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleB })).toBeVisible();

  // The drawer was opened by the app, not seeded by the test, so this reload proves the app
  // persisted the open preference itself.
  await page.reload();
  await expect(drawer).toBeVisible();
  await expect(detail.getByRole('heading', { name: titleB })).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleB })).toBeVisible();

  await page.goto(`/agents/conversations?open=${encodeURIComponent(convA.id)}`);
  await page.goto(`/agents/conversations?open=${encodeURIComponent(convB.id)}`);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`open=${convA.id}`));
  await expect(detail.getByText(drawerMessage)).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleA })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`open=${convB.id}`));
  await expect(detail.getByRole('heading', { name: titleB })).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleB })).toBeVisible();

  const missingId = `missing-conversation-${run}`;
  await page.goto(`/agents/conversations?open=${encodeURIComponent(missingId)}`);
  await expect(
    page.getByRole('region', { name: 'Conversation unavailable', exact: true }),
  ).toBeVisible();
  await expect(detail).toHaveCount(0);
  await expect(drawer.getByText(/could not be found/i)).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: titleB })).toHaveCount(0);
  await expect(page.getByText(seedB)).toHaveCount(0);

  const client = await (
    await page.request.post('/api/clients', { data: { name: `Scoped sync client ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Scoped sync project ${run}`, priority: 'HIGH' },
    })
  ).json();
  const scopedTitle = `Scoped sync thread ${run}`;
  const scoped = await (
    await page.request.post('/api/agent-conversations', {
      data: { title: scopedTitle, scope: { type: 'project', id: project.id } },
    })
  ).json();

  const scopedSeed = `Scoped sync send ${run}`;
  await page.request.post(`/api/agent-conversations/${scoped.id}/messages`, {
    data: { body: scopedSeed },
  });

  await page.goto('/agents/conversations');
  await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
  await openCommandAiDrawer(page);
  await drawer.getByRole('button', { name: 'History' }).click();
  await drawer.getByRole('button', { name: new RegExp(scopedTitle) }).click();
  await expect(page).toHaveURL(new RegExp(`open=${scoped.id}`));
  await expect(detail.getByRole('heading', { name: scopedTitle })).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 3, name: scopedTitle })).toBeVisible();
  await expect(detail.getByText(scopedSeed)).toBeVisible();

  const drawerScopedMessage = `Drawer scoped send ${run}`;
  await drawer.getByLabel('Command AI message').fill(drawerScopedMessage);
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(detail.getByText(drawerScopedMessage)).toHaveCount(1);
});

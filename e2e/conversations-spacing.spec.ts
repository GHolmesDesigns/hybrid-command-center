import { test, expect, type Locator, type Page } from '@playwright/test';

const conversationPage = (projectId: string) =>
  `/agents/conversations?scopeType=project&scopeId=${encodeURIComponent(projectId)}`;

const expectContentColumnAlignment = async (detail: Locator) => {
  const boxes = await detail
    .locator(
      '.conversation-detail-head, .conversation-decision, .conversation-messages, .conversation-compose',
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { left, right } = element.getBoundingClientRect();
        return { left, right };
      }),
    );
  expect(boxes.length).toBe(4);
  const [first, ...rest] = boxes;
  for (const box of rest) {
    expect(Math.round(box.left), 'content column left edge').toBe(Math.round(first.left));
    expect(Math.round(box.right), 'content column right edge').toBe(Math.round(first.right));
  }
};

const listFor = (page: Page) => page.getByRole('region', { name: 'Conversation list' });
const detailFor = (page: Page) => page.getByRole('region', { name: 'Conversation detail' });

test('Conversations preserves its states and aligns the reply composer at wide and narrow widths', async ({
  page,
}) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Conversations spacing ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Composer width ${run}`, priority: 'HIGH' },
    })
  ).json();
  const emptyProject = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Empty conversations ${run}`, priority: 'LOW' },
    })
  ).json();
  const activeTitle = `Wrapped operator thread ${run}`;
  const archivedTitle = `Archived operator thread ${run}`;
  const active = await (
    await page.request.post('/api/agent-conversations', {
      data: { title: activeTitle, scope: { type: 'project', id: project.id } },
    })
  ).json();
  await page.request.post(`/api/agent-conversations/${active.id}/messages`, {
    data: {
      body: `A long message that wraps across the conversation column at narrow widths ${run}.`,
    },
  });
  const archived = await (
    await page.request.post('/api/agent-conversations', {
      data: { title: archivedTitle, scope: { type: 'project', id: project.id } },
    })
  ).json();
  await page.request.post(`/api/agent-conversations/${archived.id}/archive`);

  // Empty state: the detail panel is not mounted when the filtered list has no rows.
  await page.goto(conversationPage(emptyProject.id));
  const emptyList = listFor(page);
  await expect(emptyList).toBeVisible();
  await expect(emptyList.getByText('No conversations.')).toBeVisible();
  await expect(detailFor(page)).toHaveCount(0);

  // Loading state: the existing empty shell remains readable while the list request is pending.
  let pendingRoute: import('@playwright/test').Route | undefined;
  let releasePending!: () => void;
  let resolvePendingHandled!: () => void;
  const pendingResponse = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  const pendingHandled = new Promise<void>((resolve) => {
    resolvePendingHandled = resolve;
  });
  await page.route('**/api/agent-conversations*', async (route) => {
    if (route.request().url().includes(emptyProject.id)) {
      pendingRoute = route;
      await pendingResponse;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: null, hasMore: false }),
      });
      resolvePendingHandled();
      return;
    }
    await route.continue();
  });
  await page.reload();
  await expect(listFor(page)).toBeVisible();
  await expect(listFor(page).getByText('No conversations.')).toBeVisible();
  await expect(detailFor(page)).toHaveCount(0);
  expect(pendingRoute).toBeDefined();
  releasePending();
  await pendingHandled;
  await page.unroute('**/api/agent-conversations*');

  // Error state: list failures still surface through the app's existing status toast.
  await page.route('**/api/agent-conversations*', async (route) => {
    if (route.request().url().includes(emptyProject.id)) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: `Conversations unavailable ${run}` }),
      });
      return;
    }
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('status')).toContainText(`Conversations unavailable ${run}`);
  await expect(detailFor(page)).toHaveCount(0);
  await page.unroute('**/api/agent-conversations*');

  // Selected active state: every detail section uses the same content column at both widths.
  await page.goto(conversationPage(project.id));
  const list = listFor(page);
  await list.getByRole('button', { name: new RegExp(activeTitle) }).click();
  const detail = detailFor(page);
  await expect(detail.getByText(activeTitle)).toBeVisible();
  await expect(detail.getByText(/A long message that wraps/)).toBeVisible();
  await expect(detail.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expectContentColumnAlignment(detail);

  await page.setViewportSize({ width: 700, height: 900 });
  await expect(detail).toBeVisible();
  await expectContentColumnAlignment(detail);

  // Archived state: the thread remains readable but exposes neither active-only controls.
  await page.goto(conversationPage(project.id));
  const archivedList = listFor(page);
  await expect(archivedList.getByRole('button', { name: new RegExp(activeTitle) })).toBeVisible();
  await archivedList.getByLabel('Conversation state').selectOption('ARCHIVED');
  await expect(archivedList.getByText(archivedTitle)).toBeVisible();
  await archivedList.getByRole('button', { name: new RegExp(archivedTitle) }).click();
  const archivedDetail = detailFor(page);
  await expect(archivedDetail.getByText(archivedTitle)).toBeVisible();
  await expect(archivedDetail.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
  await expect(archivedDetail.getByRole('button', { name: 'Archive' })).toHaveCount(0);
});

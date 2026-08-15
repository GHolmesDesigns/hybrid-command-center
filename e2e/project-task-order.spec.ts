import { test, expect } from '@playwright/test';

/**
 * The Wave 3 spec for C42. Two claims only a real browser and a real server can settle: the
 * project page's stages read in workflow order rather than in the alphabetical order the status
 * column used to be sorted by, and a keyboard reorder survives a reload — which means it reached
 * SQLite, not just React state. The Status board is checked afterwards for the same order,
 * because the two views share one arrangement per stage rather than keeping one each.
 *
 * Every name is stamped with the run and every query is scoped to the rows this spec created,
 * because the suite shares one database.
 */
const STAGES = [
  { status: 'BACKLOG', label: 'Backlog' },
  { status: 'TODO', label: 'To Do' },
  { status: 'IN_PROGRESS', label: 'In Progress' },
  { status: 'REVIEW', label: 'Review' },
  { status: 'COMPLETE', label: 'Complete' },
] as const;

test('a project page groups tasks by stage and keeps a keyboard reorder', async ({ page }) => {
  const run = Date.now(),
    named = (suffix: string) => `E2E Order ${suffix} ${run}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: named('Client') } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: named('Project') },
    })
  ).json();
  // Created in the alphabetical order the old sort produced, so a page that still sorted by the
  // status spelling would read them back in exactly the order they went in.
  for (const { status } of STAGES)
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: named(status), status },
    });
  // Two more in one stage, which is what there has to be for a reorder to mean anything.
  for (const suffix of ['Second TODO', 'Third TODO'])
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: named(suffix), status: 'TODO' },
    });

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { level: 1, name: named('Project') })).toBeVisible();

  // Workflow order, not BACKLOG, COMPLETE, IN_PROGRESS, REVIEW, TODO.
  const stageNames = page.locator('.task-stage > h3');
  await expect(stageNames).toHaveText(STAGES.map((stage) => new RegExp(`^${stage.label}`)));

  const todo = page.locator('.task-stage[data-status="TODO"]');
  const gripLabels = () =>
    todo
      .getByRole('button', { name: /^Drag / })
      .evaluateAll((grips) => grips.map((grip) => grip.getAttribute('aria-label')));
  expect(await gripLabels()).toEqual([
    `Drag ${named('TODO')}`,
    `Drag ${named('Second TODO')}`,
    `Drag ${named('Third TODO')}`,
  ]);

  // Keyboard only: no drag, no pointer. The selector carries the same move the grip does.
  await page.getByLabel(`Position of ${named('Third TODO')}`).selectOption('1');
  await expect(page.getByText('Reordered in To Do.', { exact: false })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: named('Project') })).toBeVisible();
  const afterReload = [
    `Drag ${named('Third TODO')}`,
    `Drag ${named('TODO')}`,
    `Drag ${named('Second TODO')}`,
  ];
  expect(await gripLabels()).toEqual(afterReload);

  // One order per stage: the board's To Do column reads the same way, because it sorts by the
  // positions this page just wrote rather than by an arrangement of its own.
  await page.goto(`/status?project=${project.id}`);
  const column = page
    .locator('.kanban-column')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'To Do' }) });
  await expect(column.locator('article.kanban-card')).toHaveText([
    new RegExp(named('Third TODO')),
    new RegExp(named('TODO')),
    new RegExp(named('Second TODO')),
  ]);

  // The row is still what opens the task; only the grip carries the drag.
  await page.goto(`/projects/${project.id}`);
  const firstRow = todo.locator('.task-row').first();
  await expect(firstRow.locator('strong')).toHaveText(named('Third TODO'));
  await firstRow.locator('strong').click();
  await expect(page.getByRole('heading', { level: 3, name: named('Third TODO') })).toBeVisible();
});

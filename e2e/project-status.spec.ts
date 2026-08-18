import { test, expect } from '@playwright/test';

/**
 * The Wave 2 spec for C41. A mixed grid is the thing under test and only a real browser can
 * settle it: the stylesheet, the status palette, and the tiles all have to agree at once, and
 * the claim — that five statuses separate at a glance, and still separate without colour — is
 * about what is painted rather than about what React returned.
 *
 * Every name is stamped with the run and every query is scoped to the tiles this spec created,
 * because the suite shares one database.
 */
const STATUSES = [
  { status: 'PLANNING', label: 'Planning' },
  { status: 'ACTIVE', label: 'Active' },
  { status: 'ON_HOLD', label: 'On hold' },
  { status: 'COMPLETE', label: 'Complete' },
  { status: 'ARCHIVED', label: 'Archived' },
] as const;

test('a mixed project grid separates its five statuses, with and without colour', async ({
  page,
}) => {
  const run = Date.now(),
    clientName = `E2E Status Client ${run}`,
    nameFor = (status: string) => `E2E ${status} ${run}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  // Four are created outright; ARCHIVED is not a status the create route accepts, so the fifth
  // is archived through the tile's own button, which is how a project reaches that state.
  for (const { status } of STATUSES.filter((entry) => entry.status !== 'ARCHIVED'))
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: nameFor(status), status },
    });
  const toArchive = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: nameFor('ARCHIVED'), status: 'ACTIVE' },
    })
  ).json();

  await page.goto('/projects?visibility=all');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `Archive ${toArchive.name}` }).click();
  await expect(page.getByText('Project archived.', { exact: false })).toBeVisible();

  const tileFor = (name: string) =>
    page.locator('article.project-tile').filter({ has: page.getByRole('heading', { name }) });

  const seen: { chip: string; tint: string; edge: string; icon: string; edgeStyle: string }[] = [];
  for (const { status, label } of STATUSES) {
    const tile = tileFor(nameFor(status));
    await expect(tile).toHaveAttribute('data-status', status);
    const chip = tile.locator('.status-label');
    // The word is always there: colour is never the only carrier of the status.
    await expect(chip).toHaveText(label);
    seen.push({
      chip: await chip.evaluate((node) => getComputedStyle(node).backgroundColor),
      tint: await tile.evaluate((node) => getComputedStyle(node).backgroundColor),
      edge: await tile.evaluate((node) => getComputedStyle(node).borderTopColor),
      edgeStyle: await tile.evaluate((node) => getComputedStyle(node).borderTopStyle),
      icon: await chip.locator('svg').evaluate((node) => node.getAttribute('class') || ''),
    });
  }

  // At a glance: five chip fills, five tints, five edges, none repeated.
  for (const key of ['chip', 'tint', 'edge'] as const)
    expect(new Set(seen.map((tile) => tile[key])).size).toBe(STATUSES.length);
  // With colour gone: five words and five icon shapes, still none repeated.
  expect(new Set(seen.map((tile) => tile.icon)).size).toBe(STATUSES.length);

  // Archived recedes without colour too — the only dashed edge in the grid.
  const [archived, ...active] = [...seen].reverse();
  expect(archived.edgeStyle).toBe('dashed');
  expect(active.every((tile) => tile.edgeStyle === 'solid')).toBe(true);
});

test('multi-select status filters survive deep links, reload, and Back', async ({ page }) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `E2E Filter Client ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `E2E Filter Project ${run}`, status: 'ACTIVE' },
    })
  ).json();
  const urgent = `E2E urgent graphics ${run}`;
  const high = `E2E high graphics ${run}`;
  const legacy = `E2E high no type ${run}`;
  await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: urgent, priority: 'URGENT', taskType: 'GRAPHICS' },
  });
  await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: high, priority: 'HIGH', taskType: 'GRAPHICS' },
  });
  await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: legacy, priority: 'HIGH' },
  });

  await page.goto(`/status?project=${project.id}&priority=HIGH%2CURGENT&type=GRAPHICS`);
  await expect(page.getByText(urgent, { exact: true })).toBeVisible();
  await expect(page.getByText(high, { exact: true })).toBeVisible();
  await expect(page.getByText(legacy, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /^Task type:/ }).click();
  await page.getByRole('checkbox', { name: 'No type' }).click();
  await expect(page.getByText(legacy, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^Task type:/ }).click();
  await expect(page.getByRole('checkbox', { name: 'Graphics' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'No type' })).toBeChecked();

  await page.getByRole('button', { name: /^Priority:/ }).click();
  await page.getByRole('checkbox', { name: 'HIGH' }).click();
  await expect(page.getByText(urgent, { exact: true })).toBeVisible();
  await expect(page.getByText(high, { exact: true })).toHaveCount(0);

  await page.goBack();
  await expect(page.getByRole('button', { name: 'Priority: 2 selected' })).toBeVisible();
  await expect(page.getByText(high, { exact: true })).toBeVisible();
  await expect(page.getByText(legacy, { exact: true })).toBeVisible();
});

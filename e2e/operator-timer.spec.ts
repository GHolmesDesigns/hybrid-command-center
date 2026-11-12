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

test('time report shows the live timer without saving and stacks cleanly on narrow screens', async ({
  page,
}) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Time report ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Time report project ${run}` },
    })
  ).json();

  await page.goto('/');
  await page.getByRole('button', { name: 'Work timer' }).click();
  const timerPanel = page.getByRole('region', { name: 'Work timer' });
  await timerPanel.getByRole('combobox').nth(0).selectOption(project.id);
  await expect(timerPanel.getByRole('combobox').nth(1).locator('option').nth(1)).toBeAttached();
  await timerPanel.getByRole('button', { name: 'Start timer' }).click();
  await expect(timerPanel.getByText('Running')).toBeVisible();
  await page.waitForTimeout(1100);
  await timerPanel.getByRole('button', { name: 'Stop and save' }).click();
  await expect(page.getByRole('button', { name: 'Work timer' })).toBeVisible();
  await page.getByRole('button', { name: 'Work timer' }).click();
  await page
    .getByRole('region', { name: 'Work timer' })
    .getByRole('button', { name: 'Start timer' })
    .click();
  await expect(page.getByRole('region', { name: 'Work timer' }).getByText('Running')).toBeVisible();

  const beforeTimer = await page.request
    .get('/api/operator-timer')
    .then((response) => response.json());
  const beforeEntries = await page.request
    .get('/api/time/entries')
    .then((response) => response.json());
  expect(
    beforeEntries.entries.some((entry: { projectId: string }) => entry.projectId === project.id),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/time');
  const clock = page.getByLabel('Elapsed work time');
  await expect(clock).toHaveText(/\d{2}:\d{2}:\d{2}/);
  const initialClock = await clock.textContent();
  await expect.poll(() => clock.textContent()).not.toBe(initialClock);

  const afterTimer = await page.request
    .get('/api/operator-timer')
    .then((response) => response.json());
  const afterEntries = await page.request
    .get('/api/time/entries')
    .then((response) => response.json());
  expect(afterTimer).toMatchObject({
    state: beforeTimer.state,
    timerId: beforeTimer.timerId,
    revision: beforeTimer.revision,
    runningSince: beforeTimer.runningSince,
  });
  expect(afterEntries.entries).toEqual(beforeEntries.entries);

  const wide = await page.evaluate(() => {
    const clockPanel = document
      .querySelector('.workspace-time-clock-panel')!
      .getBoundingClientRect();
    const report = document.querySelector('.workspace-time-report-column')!.getBoundingClientRect();
    return { clockRight: clockPanel.right, reportLeft: report.left };
  });
  expect(wide.clockRight).toBeLessThan(wide.reportLeft);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => {
    const clockPanel = document
      .querySelector('.workspace-time-clock-panel')!
      .getBoundingClientRect();
    const report = document.querySelector('.workspace-time-report-column')!.getBoundingClientRect();
    const filters = document.querySelector('.workspace-time-filters')!.getBoundingClientRect();
    const controls = [
      ...document.querySelectorAll('.workspace-time-filters input, .workspace-time-filters select'),
    ];
    return {
      clockBottom: clockPanel.bottom,
      reportTop: report.top,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('body *')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            className: String(element.className),
            right: rect.right,
            width: rect.width,
          };
        })
        .filter((element) => element.right > window.innerWidth + 1)
        .slice(0, 12),
      filtersLeft: filters.left,
      filtersRight: filters.right,
      controls: controls.map((control) => {
        const rect = control.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    };
  });
  expect(narrow.reportTop).toBeGreaterThanOrEqual(narrow.clockBottom);
  expect(narrow.documentWidth, JSON.stringify(narrow.overflowing)).toBeLessThanOrEqual(
    narrow.viewportWidth,
  );
  expect(
    narrow.controls.every(
      (control) => control.left >= narrow.filtersLeft && control.right <= narrow.filtersRight,
    ),
  ).toBe(true);

  const cleanup = await page.request.post('/api/operator-timer/discard', {
    data: { timerId: afterTimer.timerId, revision: afterTimer.revision },
  });
  expect(cleanup.ok()).toBe(true);
});

test('workspace time report edits an entry and keeps the change after reload', async ({ page }) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Time edit ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Time edit project ${run}` },
    })
  ).json();
  const task = await (
    await page.request.post('/api/tasks', {
      data: { projectId: project.id, title: `Time edit task ${run}` },
    })
  ).json();
  const categoriesResponse = await page.request.get(`/api/projects/${project.id}/time/categories`);
  expect(categoriesResponse.ok()).toBe(true);
  const categories = await categoriesResponse.json();
  const category = categories.find((item: { selectable: boolean }) => item.selectable);
  expect(category).toBeTruthy();

  const created = await page.request.post(`/api/projects/${project.id}/time/entries`, {
    data: {
      categoryId: category.id,
      taskId: task.id,
      startDate: new Date().toISOString().slice(0, 10),
      startTime: '09:00',
      endTime: '10:00',
      timeZone: 'UTC',
      notes: `Original note ${run}`,
    },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/time');
  await expect(page.getByRole('link', { name: task.title })).toHaveAttribute(
    'href',
    `/countdown/${task.id}`,
  );
  await page.getByRole('link', { name: task.title }).click();
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible();
  await page.goto('/time');
  const taskRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: task.title }) });
  await taskRow.getByRole('button', { name: /Edit time entry for/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit time entry' });
  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopSpacing = await dialog.evaluate((element) => {
    const form = element.querySelector('form')!;
    const dateFields = element.querySelector('.workspace-time-edit-date-fields')!;
    const actions = element.querySelector('.modal-actions')!;
    return {
      padding: parseFloat(getComputedStyle(element).paddingLeft),
      formGap: parseFloat(getComputedStyle(form).rowGap),
      dateColumns: getComputedStyle(dateFields).gridTemplateColumns.split(' ').length,
      actionGap: parseFloat(getComputedStyle(actions).columnGap),
    };
  });
  expect(desktopSpacing.padding).toBeGreaterThanOrEqual(24);
  expect(desktopSpacing.formGap).toBeGreaterThanOrEqual(12);
  expect(desktopSpacing.dateColumns).toBe(2);
  expect(desktopSpacing.actionGap).toBeGreaterThanOrEqual(12);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowSpacing = await dialog.evaluate((element) => ({
    padding: parseFloat(getComputedStyle(element).paddingLeft),
    dateColumns: getComputedStyle(
      element.querySelector('.workspace-time-edit-date-fields')!,
    ).gridTemplateColumns.split(' ').length,
    buttonsInside: [...element.querySelectorAll('.modal-actions button')].every((button) => {
      const rect = button.getBoundingClientRect();
      const modal = element.getBoundingClientRect();
      return rect.left >= modal.left && rect.right <= modal.right;
    }),
  }));
  expect(narrowSpacing.padding).toBeGreaterThanOrEqual(16);
  expect(narrowSpacing.dateColumns).toBe(1);
  expect(narrowSpacing.buttonsInside).toBe(true);
  await dialog.getByLabel('Notes').fill(`Updated note ${run}`);
  await dialog.getByRole('button', { name: 'Save entry' }).click();
  await expect(page.getByText(`Updated note ${run}`)).toBeVisible();
  await page.reload();
  await expect(page.getByText(`Updated note ${run}`)).toBeVisible();
});

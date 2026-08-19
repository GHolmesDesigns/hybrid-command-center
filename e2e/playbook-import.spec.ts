import { test, expect } from '@playwright/test';

/**
 * The Stage 4 spec for C16. What only a real browser and a real database can settle is that
 * the preview is a read-only step that writes nothing, that confirming it creates the whole
 * hierarchy in one action, that the receipt survives the modal closing and a reload, and that
 * running the same playbook again creates nothing the second time.
 *
 * Every name is stamped with the run and every count is read back through the API for the rows
 * this spec created, because the suite shares one database.
 */
test('a campaign playbook previews, imports once, and refuses to duplicate itself', async ({
  page,
}) => {
  const run = Date.now();
  const clientName = `E2E Playbook Client ${run}`;
  const projectName = `E2E Playbook Campaign ${run}`;
  const firstTask = `E2E Week 1 blog post ${run}`;
  const secondTask = `E2E Week 1 social set ${run}`;
  const playbook = [
    '[Clients]',
    'client_key\tname\tcontact_name\temail\tphone\twebsite\tnotes',
    `CLI-E2E\t${clientName}\tDana Holmes\tdana@example.com\t\t\tImported by the E2E suite`,
    '[Projects]',
    'project_key\tclient_key\tname\tstatus\tpriority\tstart_date\ttarget_deadline\tdescription\tnotes\tposition',
    `PRJ-E2E\tCLI-E2E\t${projectName}\tACTIVE\tHIGH\t2026-03-01\t2026-04-30\tSix weeks of work\t\t1`,
    '[Tasks]',
    'task_key\tproject_key\ttitle\ttask_type\tstatus\tpriority\tstart_date\tdue_date\tdescription\tnotes\tposition',
    `TSK-E2E-1\tPRJ-E2E\t${firstTask}\tBLOG_POST\tTODO\tHIGH\t\t2026-03-02\t\t\t1`,
    `TSK-E2E-2\tPRJ-E2E\t${secondTask}\t\tBACKLOG\tMEDIUM\t\t\t\t\t2`,
    '[ChecklistItems]',
    'task_key\titem_order\ttitle\tcompleted',
    'TSK-E2E-1\t1\tDraft the post\tTRUE',
    'TSK-E2E-1\t2\tEdit for clarity\tFALSE',
    '[Dependencies]',
    'task_key\tprerequisite_task_key',
    'TSK-E2E-2\tTSK-E2E-1',
  ].join('\n');

  const clientsNamed = async () =>
    (
      (await (await page.request.get('/api/clients')).json()) as { name: string; id: string }[]
    ).filter((client) => client.name === clientName);
  const importedTasks = async () =>
    (
      (await (await page.request.get('/api/tasks')).json()) as {
        title: string;
        projectName?: string;
        checklistTotal: number;
        blocked: boolean;
      }[]
    ).filter((task) => task.projectName === projectName);

  /** The activity rows this run wrote, read back through the API the page reads. */
  const activityFor = async (receiptId: string) =>
    (await (
      await page.request.get(
        `/api/integrations/activity?source=campaign-playbook&correlationId=${receiptId}`,
      )
    ).json()) as {
      operation: string;
      outcome: string;
      summary: string;
      entityCount: number;
      entities: { type: string; id: string; label: string }[];
    }[];
  const receipts = async () =>
    (await (await page.request.get('/api/import/receipts')).json()) as { id: string }[];
  const newestReceiptId = async () => (await receipts())[0].id;

  await page.goto('/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  // The receipts panel is here to read; whether it is empty is not this spec's claim to make,
  // because every spec shares one database and another may have imported before this one ran.
  // What this spec owns is the number it started from and the one receipt it goes on to add.
  await expect(page.getByRole('heading', { name: 'Import receipts' })).toBeVisible();
  const receiptsBefore = (await receipts()).length;

  // The dry run. It reports what it would do and writes nothing at all.
  await page.getByRole('button', { name: /Import a playbook/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Or paste the tabs').fill(playbook);
  await dialog.getByRole('button', { name: /Check this playbook/ }).click();
  await expect(dialog.getByText('Ready to create 7 records')).toBeVisible();
  expect(await clientsNamed()).toHaveLength(0);

  // The commit. One action, the whole hierarchy.
  await dialog.getByRole('button', { name: /Import 7 records/ }).click();
  await expect(dialog.getByText('Imported 7 records')).toBeVisible();
  expect(await receipts()).toHaveLength(receiptsBefore + 1);
  const [client] = await clientsNamed();
  expect(client).toBeTruthy();
  // Nothing about the import touches Drive, so the imported client is simply not connected.
  expect((client as unknown as { driveStatus: string }).driveStatus).toBe('DISCONNECTED');
  const tasks = await importedTasks();
  expect(tasks.map((task) => task.title).sort()).toEqual([firstTask, secondTask].sort());
  // The workbook authored this checklist, so the BLOG_POST template did not seed another.
  expect(tasks.find((task) => task.title === firstTask)?.checklistTotal).toBe(2);
  // The dependency landed: the second task is blocked by the first, which is not complete.
  expect(tasks.find((task) => task.title === secondTask)?.blocked).toBe(true);

  // The receipt outlives the modal and a reload.
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.reload();
  const receipt = page.getByText('7 created · 0 skipped · 0 failed').first();
  await expect(receipt).toBeVisible();

  // C17: the import also left an audit record, on the page and naming what it created by id.
  const receiptId = await newestReceiptId();
  const [record] = await activityFor(receiptId);
  expect(record).toMatchObject({ operation: 'playbook.import', outcome: 'SUCCESS' });
  // Four addressable records: the client, the project, and the two tasks.
  expect(record.entityCount).toBe(4);
  expect(record.entities.map((entity) => entity.label).sort()).toEqual(
    [clientName, projectName, firstTask, secondTask].sort(),
  );
  const [importedClient] = record.entities.filter((entity) => entity.type === 'client');
  expect(importedClient.id).toBe(client.id);
  await expect(page.getByText(record.summary).first()).toBeVisible();
  await receipt.click();
  await expect(
    page.getByText(/Recorded in integration activity as Playbook import — succeeded/).first(),
  ).toBeVisible();

  // The same playbook again: every row matches something already here, so nothing is created.
  await page.getByRole('button', { name: /Import a playbook/ }).click();
  const second = page.getByRole('dialog');
  await second.getByLabel('Or paste the tabs').fill(playbook);
  await second.getByRole('button', { name: /Check this playbook/ }).click();
  await expect(second.getByText('Ready to create 0 records')).toBeVisible();
  await expect(second.getByText('7 rows already in this workspace')).toBeVisible();
  await second.getByRole('button', { name: /Import 0 records/ }).click();
  await expect(second.getByText('Imported 0 records')).toBeVisible();
  await second.getByRole('button', { name: 'Done' }).click();

  expect(await clientsNamed()).toHaveLength(1);
  expect(await importedTasks()).toHaveLength(2);
  await expect(page.getByText('0 created · 7 skipped · 0 failed').first()).toBeVisible();

  // A malformed playbook is refused with the row and column to fix, and writes nothing.
  await page.getByRole('button', { name: /Import a playbook/ }).click();
  const third = page.getByRole('dialog');
  await third
    .getByLabel('Or paste the tabs')
    .fill(playbook.replace('\t2026-03-02\t', '\t2026-02-30\t'));
  await third.getByRole('button', { name: /Check this playbook/ }).click();
  await expect(third.getByText('4 rows to fix first')).toBeVisible();
  await expect(third.getByText('due_date: that is not a real calendar date.')).toBeVisible();
  // The confirm button never offers a record count while the import is refused.
  await expect(third.getByRole('button', { name: /Fix 4 rows first/ })).toBeDisabled();
  await expect(third.getByRole('button', { name: /Import \d+ records?/ })).toBeHidden();
});

import { test, expect } from '@playwright/test';
import {
  editMergeFieldAndWait,
  gotoSettled,
  mergeConfirmationReady,
  waitForMergePreview,
} from './ready';

/**
 * The Wave 10 spec for C70. Import identity is only worth anything across two separate imports of a
 * changed workbook, against a workspace that kept what the first one recorded — which is exactly
 * what a real browser and a real database settle and a unit test has to assume.
 *
 * The flow is the one the card exists for: import a playbook that carries the identity its client
 * has at its source, rename the client at the source, import again, and get the same client rather
 * than a second one. Then contradict the identity and watch the whole import be refused. Then merge
 * the client away and watch the identity follow the work.
 *
 * Every name is stamped with the run and every count is read back through the API for the rows this
 * spec created, because the suite shares one database.
 */
test('a client identity outlives a rename at its source, and follows a merge', async ({ page }) => {
  const run = Date.now();
  const source = '9d3f1c62-5a47-4e8b-b0d2-7c6841ae5f30';
  const externalId = `e2e-identity-${run}`;
  const firstName = `E2E Identity Client ${run}`;
  const renamed = `E2E Identity Renamed ${run}`;
  const rivalName = `E2E Identity Rival ${run}`;
  const projectName = `E2E Identity Campaign ${run}`;

  /** The same playbook every time, with only the client's name changing — as a rename would. */
  const playbook = (clientName: string) =>
    [
      '[Clients]',
      'client_key\tname\tcontact_name\temail\tphone\twebsite\tnotes\tclient_import_source\tclient_import_id',
      `CLI-E2E\t${clientName}\t\t\t\t\tImported by the E2E suite\t${source}\t${externalId}`,
      '[Projects]',
      'project_key\tclient_key\tname\tstatus\tpriority\tstart_date\ttarget_deadline\tdescription\tnotes\tposition',
      `PRJ-E2E\tCLI-E2E\t${projectName}\tACTIVE\tHIGH\t\t\t\t\t1`,
      '[Tasks]',
      'task_key\tproject_key\ttitle\ttask_type\tstatus\tpriority\tstart_date\tdue_date\tdescription\tnotes\tposition',
      `TSK-E2E\tPRJ-E2E\tE2E Identity task ${run}\t\tTODO\tMEDIUM\t\t\t\t\t1`,
    ].join('\n');

  const clientsNamed = async (name: string) =>
    (
      (await (await page.request.get('/api/clients')).json()) as { id: string; name: string }[]
    ).filter((client) => client.name === name);
  const projects = async () =>
    (await (await page.request.get('/api/projects')).json()) as {
      id: string;
      name: string;
      clientId: string;
    }[];
  /** The project this spec imported, whoever owns it now. */
  const importedProject = async () =>
    (await projects()).find((project) => project.name === projectName);

  /** Opens the modal, pastes a playbook, and reads the dry run. */
  const check = async (text: string) => {
    await page.getByRole('button', { name: /Import a playbook/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Or paste the tabs').fill(text);
    await dialog.getByRole('button', { name: /Check this playbook/ }).click();
    return dialog;
  };

  await gotoSettled(page, '/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();

  // The first import creates the client and records the identity it arrived under.
  const first = await check(playbook(firstName));
  await expect(first.getByText('Ready to create 3 records')).toBeVisible();
  await first.getByRole('button', { name: /Import 3 records/ }).click();
  await expect(first.getByText('Imported 3 records')).toBeVisible();
  await first.getByRole('button', { name: 'Done' }).click();
  const [client] = await clientsNamed(firstName);
  expect(client).toBeTruthy();

  // The source renames the client. Before this card, the next import created a second one.
  const second = await check(playbook(renamed));
  await expect(second.getByText('Ready to create 0 records')).toBeVisible();
  await second.getByText('3 rows already in this workspace').click();
  await expect(
    second.getByText('This source identity is already recorded against a client', { exact: false }),
  ).toBeVisible();
  await second.getByRole('button', { name: /Import 0 records/ }).click();
  await expect(second.getByText('Imported 0 records')).toBeVisible();
  await second.getByRole('button', { name: 'Done' }).click();
  // One client, still under the name this workspace gave it: an import edits nothing it matched.
  expect(await clientsNamed(renamed)).toHaveLength(0);
  expect(await clientsNamed(firstName)).toHaveLength(1);
  expect((await importedProject())?.clientId).toBe(client.id);

  // A second client, whose name the playbook then claims while carrying the first one's identity.
  const rival = await (
    await page.request.post('/api/clients', { data: { name: rivalName } })
  ).json();
  const third = await check(playbook(rivalName));
  // The client row and the two rows that depended on it: nothing in this playbook can be written.
  await expect(third.getByText('3 rows to fix first')).toBeVisible();
  await expect(third.getByText('Nothing was imported.', { exact: false })).toBeVisible();
  await expect(third.getByRole('button', { name: /Fix 3 rows first/ })).toBeDisabled();
  await expect(third.getByRole('button', { name: /Import \d+ records?/ })).toBeHidden();
  await third.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  // Nothing was written by the refusal: the rival has no project at all.
  expect((await projects()).filter((project) => project.clientId === rival.id)).toHaveLength(0);

  /**
   * Merging the client away carries the identity to the survivor, which the dialog says first.
   * C71's half of the milestone rides here: the merge is confirmed with values chosen field by
   * field — the imported client's notes taken across, a contact name typed in the dialog, the
   * survivor's own name kept — and the identity has to resolve to the survivor afterwards all
   * the same, whatever it now calls itself.
   */
  const survivorName = `E2E Identity Survivor ${run}`;
  const survivor = await (
    await page.request.post('/api/clients', {
      data: { name: survivorName, contactName: 'E2E Survivor Contact' },
    })
  ).json();
  await gotoSettled(page, `/clients/${client.id}`);
  await page.getByRole('button', { name: 'Merge client' }).click();
  const merge = page.getByRole('dialog');
  await merge.getByLabel('Merge into').selectOption(survivor.id);
  const plan = merge.getByLabel('Merge preview');
  await expect(plan.getByText('One import identity moves', { exact: false })).toBeVisible();
  await expect(plan.getByLabel('Import identities that move').getByText(externalId)).toBeVisible();
  // The notes the playbook wrote onto the imported client, offered beside the survivor's blank.
  const notes = plan.getByRole('group', { name: 'Notes' });
  await expect(notes.getByText('Imported by the E2E suite')).toBeVisible();
  await Promise.all([
    waitForMergePreview(page),
    notes.getByRole('radio', { name: /Use source/ }).click(),
  ]);
  const contact = plan.getByRole('group', { name: 'Contact name' });
  await Promise.all([
    waitForMergePreview(page),
    contact.getByRole('radio', { name: /Custom value/ }).click(),
  ]);
  // Debounced custom text is planned after fill settles — listen once the value is in the field.
  const chosenContact = `E2E Chosen Contact ${run}`;
  await editMergeFieldAndWait(page, async () => {
    await contact.getByLabel('Custom contact name').fill(chosenContact);
  });
  await expect(contact.getByLabel('Custom contact name')).toHaveValue(chosenContact);
  // The name is left on the survivor, so its web address is not rewritten either.
  await expect(
    plan
      .getByRole('group', { name: 'Name', exact: true })
      .getByRole('radio', { name: /Keep destination/ }),
  ).toBeChecked();
  await mergeConfirmationReady(page, merge);
  await merge.getByRole('button', { name: 'Merge clients' }).click();
  await expect(page.getByRole('heading', { name: survivorName })).toBeVisible();

  // The survivor holds exactly what was chosen: the imported notes, the typed contact, its name.
  const merged = (
    (await (await page.request.get('/api/clients')).json()) as {
      id: string;
      name: string;
      slug: string;
      contactName?: string;
      notes?: string;
    }[]
  ).find((row) => row.id === survivor.id);
  expect(merged).toMatchObject({
    name: survivorName,
    slug: survivor.slug,
    contactName: chosenContact,
    notes: 'Imported by the E2E suite',
  });

  // The identity now resolves to the survivor, one hop, so the playbook adds nothing to the source.
  await gotoSettled(page, '/import');
  const fourth = await check(playbook(`E2E Identity Renamed Again ${run}`));
  await expect(fourth.getByText('Ready to create 0 records')).toBeVisible();
  await fourth.getByRole('button', { name: /Import 0 records/ }).click();
  await expect(fourth.getByText('Imported 0 records')).toBeVisible();
  await fourth.getByRole('button', { name: 'Done' }).click();
  expect((await importedProject())?.clientId).toBe(survivor.id);
});

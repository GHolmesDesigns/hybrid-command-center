import { test, expect } from '@playwright/test';

/**
 * The Wave 5 spec for C49. Merging is the one operation that moves a whole portfolio between
 * two records, and only a real browser settles the claim the card is about: the dialog, the
 * server's plan, and the two client pages have to agree that the work is now somewhere else and
 * that the place it came from says where it went.
 *
 * Every name is stamped with the run and every assertion is scoped to the rows this spec
 * created, because the suite shares one database.
 */
test('a client merges into another, and the archived source points at it', async ({ page }) => {
  const run = Date.now(),
    sourceName = `E2E Merge Source ${run}`,
    destinationName = `E2E Merge Survivor ${run}`,
    projectName = `E2E Merged Project ${run}`,
    taskTitle = `E2E Merged Task ${run}`;

  const source = await (
    await page.request.post('/api/clients', {
      data: {
        name: sourceName,
        contactName: 'E2E Old Contact',
        phone: '020 7946 0000',
        notes:
          'A deliberately long source note that wraps in the merge modal at a narrow viewport.',
      },
    })
  ).json();
  const destination = await (
    await page.request.post('/api/clients', {
      data: { name: destinationName, contactName: 'E2E Current Contact' },
    })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: source.id, name: projectName },
    })
  ).json();
  const task = await (
    await page.request.post('/api/tasks', { data: { projectId: project.id, title: taskTitle } })
  ).json();

  await page.goto(`/clients/${source.id}`);
  await page.getByRole('button', { name: 'Merge client' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Nothing can be confirmed before the server has planned the merge.
  await expect(dialog.getByRole('button', { name: 'Merge clients' })).toBeDisabled();
  await dialog.getByLabel('Merge into').selectOption(destination.id);

  const plan = dialog.getByLabel('Merge preview');
  await expect(
    plan.getByRole('heading', { name: `${sourceName} → ${destinationName}` }),
  ).toBeVisible();
  await expect(plan.getByText(projectName)).toBeVisible();
  await expect(plan.getByText('There is no undo.', { exact: false })).toBeVisible();

  /**
   * C71. Every field starts on the client being kept, blank or not, and only what is chosen
   * moves. The phone number is taken from the duplicate; the contact name is left alone, and the
   * duplicate's own is what a merge would have had to guess at.
   */
  const phone = plan.getByRole('group', { name: 'Phone' });
  await expect(phone.getByRole('radio', { name: /Keep destination/ })).toBeChecked();
  await expect(phone.getByText('(none)')).toBeVisible();
  await page.setViewportSize({ width: 420, height: 900 });
  const notes = plan.getByRole('group', { name: 'Notes' });
  await expect(notes.getByText(/deliberately long source note/)).toBeVisible();
  const notesChoiceAlignment = await notes
    .locator('.merge-choice')
    .filter({ hasText: 'Use source' })
    .evaluate((row) => getComputedStyle(row).alignItems);
  expect(notesChoiceAlignment).toBe('flex-start');
  await phone.getByRole('radio', { name: /Use source/ }).click();
  const contact = plan.getByRole('group', { name: 'Contact name' });
  await expect(contact.getByRole('radio', { name: /Keep destination/ })).toBeChecked();
  // The choice re-plans, so the confirmation is only offered again once the server has it.
  const confirm = dialog.getByRole('button', { name: 'Merge clients' });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The successful flow lands on the survivor, which now owns the project.
  await expect(page).toHaveURL(new RegExp(`/clients/${destination.id}$`));
  await expect(page.getByRole('heading', { name: destinationName })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(projectName) })).toBeVisible();
  await expect(page.getByText('merged into', { exact: false })).toBeVisible();

  // The survivor took the one value that was chosen and kept everything else of its own.
  const survivor = (
    (await (await page.request.get('/api/clients')).json()) as {
      id: string;
      name: string;
      contactName?: string;
      phone?: string;
    }[]
  ).find((row) => row.id === destination.id);
  expect(survivor).toMatchObject({
    name: destinationName,
    contactName: 'E2E Current Contact',
    phone: '020 7946 0000',
  });

  // The task came with its project, and the API agrees about who owns both.
  const moved = await (await page.request.get(`/api/tasks?projectId=${project.id}`)).json();
  expect(moved.map((row: { id: string; clientId: string }) => [row.id, row.clientId])).toEqual([
    [task.id, destination.id],
  ]);

  // The source explains where its work went and cannot be restored from its own page.
  await page.goto(`/clients/${source.id}`);
  await expect(page.getByText(`This client was merged into ${destinationName}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unarchive client' })).toHaveCount(0);
  await page.getByRole('link', { name: `Open ${destinationName}` }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${destination.id}$`));

  // And its list card offers a badge rather than a button the API would refuse.
  await page.goto('/clients?visibility=archived');
  const card = page
    .locator('article.entity-card')
    .filter({ has: page.getByRole('heading', { name: sourceName }) });
  await expect(card.getByText(`Merged into ${destinationName}`)).toBeVisible();
  await expect(card.getByRole('button', { name: `Unarchive ${sourceName}` })).toHaveCount(0);
  const refused = await page.request.post(`/api/clients/${source.id}/unarchive`);
  expect(refused.status()).toBe(409);

  // The suite shares one database and one board, so the card this spec parked in Backlog is
  // taken back off it. Clients are archive-only, and the two here are archived or inert.
  expect((await page.request.delete(`/api/tasks/${task.id}`)).status()).toBe(200);
});

import { test, expect } from '@playwright/test';

/**
 * The Stage 4 spec for C18. The E2E suite runs against a real server with no Google
 * credentials and no connection — which is exactly the state most installs of this app are
 * in — so what a real browser settles here is that the Files module is honest about it: the
 * page loads, names the problem, offers the step that fixes it, and never claims a file
 * list it does not have.
 *
 * It also settles the read-only guarantee end to end. Real Drive is never contacted (there
 * is nothing to contact it with), and the API is asked directly whether a write exists.
 * Every name is stamped with the run, because the suite shares one database.
 */
test('the Files page browses a project read-only and states its Drive problem plainly', async ({
  page,
}) => {
  const run = Date.now();
  const clientName = `E2E Files Client ${run}`;
  const projectName = `E2E Files Project ${run}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: projectName, priority: 'HIGH' },
    })
  ).json();

  // The module is in the sidebar, not listed as future work beside Calendar. Scoped to the
  // navigation, because a project named after this spec is a link that says "Files" too.
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await page.goto('/');
  await expect(nav.getByRole('link', { name: 'Files', exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Files' })).toBeVisible();

  // A project reaches its own folder from its detail page, and the address carries it.
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('link', { name: /Browse files/ }).click();
  await expect(page).toHaveURL(new RegExp(`/files\\?project=${project.id}`));
  await expect(page.getByLabel('Project')).toHaveValue(project.id);

  // No credentials on this machine, so that is what it says — with somewhere to go.
  await expect(page.getByRole('alert')).toContainText(/Google Drive is not/);
  await expect(page.getByRole('link', { name: 'Open Settings' })).toBeVisible();
  await expect(page.getByRole('table')).toBeHidden();
  // The read-only promise is on the page, not only in the docs.
  await expect(page.getByText(/never touches a Drive file/)).toBeVisible();

  // Keyboard reaches the controls in reading order. The folder picker is deliberately
  // skipped: with no Drive folder there is nothing to pick, and it says so rather than
  // taking a tab stop that leads nowhere.
  await page.getByLabel('Project').focus();
  await expect(page.getByLabel('Project')).toBeFocused();
  await expect(page.getByLabel('Folder')).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Open Settings' })).toBeFocused();

  // The listing endpoint answers with a state rather than an error, and carries no secret.
  const listing = await page.request.get(`/api/projects/${project.id}/files`);
  expect(listing.status()).toBe(200);
  const body = await listing.json();
  expect(['NOT_CONFIGURED', 'NOT_CONNECTED']).toContain(body.state);
  expect(body.files).toEqual([]);
  expect(JSON.stringify(body)).not.toMatch(/access_token|refresh_token|client_secret/);

  // There is no mutation path beside it: every write shape the card ruled out is a 404.
  for (const attempt of [
    page.request.post(`/api/projects/${project.id}/files`, { data: { name: 'x' } }),
    page.request.patch(`/api/projects/${project.id}/files`, { data: { name: 'x' } }),
    page.request.delete(`/api/projects/${project.id}/files`),
  ])
    expect((await attempt).status()).toBe(404);

  // A folder ID nobody can browse still answers with the connection state rather than a
  // refusal, because a shared link that outlived a disconnection should say what is wrong
  // with the connection, not argue about the folder. Refusing an out-of-scope folder needs
  // a connected Drive to be meaningful, so that path is covered by the mock-provider tests.
  const stale = await page.request.get(
    `/api/projects/${project.id}/files?folderId=someone-elses-folder`,
  );
  expect(stale.status()).toBe(200);
  expect((await stale.json()).files).toEqual([]);
});

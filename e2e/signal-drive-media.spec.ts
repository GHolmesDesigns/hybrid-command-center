import { expect, test } from '@playwright/test';

/**
 * Wave 11's browser flow: the composer resolves a Drive link through the injected mock, saves the
 * version-bound descriptor, previews without reading Drive, then the confirmed submit revalidates
 * and streams those mock bytes to the mock publisher as a fresh provider media id.
 */
test('a Drive asset previews, streams through the mock providers, and shows delivery', async ({
  page,
}) => {
  const text = `Wave 11 Drive media ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['li'],
      date: '2099-11-18',
      time: '09:00',
      format: 'IMAGE',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const post = await created.json();

  await page.goto('/signal?month=2099-11');
  await page
    .getByRole('region', { name: '2099-11-18' })
    .getByRole('button', { name: `Edit ${text}` })
    .click();
  const editor = page.getByRole('dialog');

  await editor
    .getByLabel('Add a Drive file by link')
    .fill('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv');
  await editor.getByRole('button', { name: 'Add Drive file' }).click();
  await expect(editor.getByText(/a post carries one file at a time/)).toBeVisible();

  await editor
    .getByLabel('Add a Drive file by link')
    .fill('https://drive.google.com.evil.example/file/d/1AbCdEfGhIjKlMnOpQrStUv/view');
  await editor.getByRole('button', { name: 'Add Drive file' }).click();
  await expect(editor.getByText(/is not Google Drive/)).toBeVisible();

  await editor
    .getByLabel('Add a Drive file by link')
    .fill('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view');
  await editor.getByRole('button', { name: 'Add Drive file' }).click();
  await expect(editor.getByText('e2e-drive-image.png')).toBeVisible();
  await expect(editor.getByText('image/png · 4 B')).toBeVisible();
  await editor.getByRole('button', { name: 'Save post' }).click();

  const stored = await (await page.request.get(`/api/signal/posts/${post.id}`)).json();
  expect(stored.media).toMatchObject([
    {
      source: 'DRIVE',
      driveName: 'e2e-drive-image.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      driveVersion: '7',
    },
  ]);

  await page
    .getByRole('region', { name: '2099-11-18' })
    .getByRole('button', { name: `Edit ${text}` })
    .click();
  await editor.getByRole('button', { name: 'Show preview' }).click();
  const preview = editor.getByRole('region', { name: 'Publish confirmation' });
  await expect(preview).toContainText('LinkedIn → @gholmes-designs · Ready to send');
  await preview.getByRole('button', { name: 'Confirm and submit' }).click();
  await expect(editor.getByRole('region', { name: 'Delivery' })).toContainText(
    'Accepted, not out yet',
  );

  const publications = await (
    await page.request.get(`/api/signal/posts/${post.id}/publications`)
  ).json();
  expect(publications).toHaveLength(1);
  expect(publications[0]).toMatchObject({
    sentProviderMediaIds: ['mock-media-1'],
    sentMediaSources: {
      version: 1,
      items: [{ source: 'DRIVE', driveName: 'e2e-drive-image.png', sizeBytes: 4 }],
    },
  });
});

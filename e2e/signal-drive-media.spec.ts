import { expect, test } from '@playwright/test';

/**
 * Wave B's milestone flow: a Signal post's media is a discriminated reference, and the Drive half
 * of it is refused precisely rather than vaguely.
 *
 * **Why this spec stops where it does.** Resolving a Drive link needs a connected Drive account, and
 * the end-to-end run has no credentials and must never contact real Drive (`AGENTS.md`). Everything
 * that happens *before* the account is reached is still real, and is what this covers: the composer
 * offers the paste, the server parses the link, checks the host, and answers with the reason it will
 * not take one — each of which is a distinct message a person acts on. What a resolved Drive file
 * then looks like is exercised against the mock provider in
 * `server/signal/signal-media.test.ts` and `client/src/Signal.test.tsx`, which is the only place it
 * can be.
 *
 * The public-URL half runs end to end, including the fact that a saved post comes back carrying
 * both shapes of the list.
 */
test('a post carries discriminated media, and a Drive link is refused with its own reason', async ({
  page,
}) => {
  const text = `Wave B media ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['li'],
      media: [{ source: 'URL', url: 'https://cdn.example.com/wave-b.jpg' }],
      date: '2099-11-18',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const post = await created.json();
  // Both shapes, from one stored list: the descriptors say what each reference is, and the URLs are
  // still the vocabulary every selection and preview speaks.
  expect(post.media).toEqual([
    {
      source: 'URL',
      url: 'https://cdn.example.com/wave-b.jpg',
      driveFileId: null,
      driveName: null,
      mimeType: null,
      sizeBytes: null,
      driveVersion: null,
      driveModifiedAt: null,
      driveChecksum: null,
      driveVerifiedAt: null,
    },
  ]);
  expect(post.mediaUrls).toEqual(['https://cdn.example.com/wave-b.jpg']);

  await page.goto('/signal?month=2099-11');
  await page
    .getByRole('region', { name: '2099-11-18' })
    .getByRole('button', { name: `Edit ${text}` })
    .click();
  const editor = page.getByRole('dialog');
  await expect(editor.getByLabel('Media URL 1')).toHaveValue('https://cdn.example.com/wave-b.jpg');

  // A folder is not a file, and the refusal says which thing to copy instead.
  await editor
    .getByLabel('Add a Drive file by link')
    .fill('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv');
  await editor.getByRole('button', { name: 'Add Drive file' }).click();
  await expect(editor.getByText(/a post carries one file at a time/)).toBeVisible();

  // A link on somebody else's host never reaches Drive at all: the host check comes first, so the
  // answer is about the paste rather than about a connection.
  await editor
    .getByLabel('Add a Drive file by link')
    .fill('https://drive.google.com.evil.example/file/d/1AbCdEfGhIjKlMnOpQrStUv/view');
  await editor.getByRole('button', { name: 'Add Drive file' }).click();
  await expect(editor.getByText(/is not Google Drive/)).toBeVisible();

  // Nothing was added by either refusal, and the post's own media is untouched.
  await expect(editor.getByRole('button', { name: 'Recheck Drive file' })).toHaveCount(0);
  await expect(editor.getByLabel('Media URL 1')).toHaveValue('https://cdn.example.com/wave-b.jpg');

  // And a well-formed link on the right host is refused for the honest reason — this run has no
  // Drive connection — rather than being quietly accepted as an unresolved reference.
  await editor
    .getByLabel('Add a Drive file by link')
    .fill('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view');
  await editor.getByRole('button', { name: 'Add Drive file' }).click();
  await expect(editor.getByText(/Google Drive is not connected/)).toBeVisible();

  const reread = await (await page.request.get(`/api/signal/posts/${post.id}`)).json();
  expect(reread.media).toHaveLength(1);
  expect(reread.media[0].source).toBe('URL');
});

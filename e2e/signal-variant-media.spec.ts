import { expect, test } from '@playwright/test';

/**
 * Wave 11's second browser flow (C76): the two halves of a media role.
 *
 * The **verified** half is LinkedIn's document post. It is not a role row at all — it is a PDF in
 * the post's own media plus the document title this app has always collected — and the live probe
 * confirmed the provider accepts and reads back both, so the first test walks it end to end: Drive
 * link, saved descriptor, title override, preview, confirmed submit, provider media id, delivery.
 *
 * The **unverified** half is YouTube's thumbnail. Post Bridge names the field and the probe could
 * not establish that it works, so the composer offers the role, stores it version-bound, says out
 * loud that it is not sent, and the preview says so again. Two posts rather than two channels on
 * one: a PDF is a document post on LinkedIn and forbidden on YouTube, so a post carrying both
 * channels could never be ready to send, and it is the sending that is being proved here.
 */

test('a Drive PDF publishes to LinkedIn as a document post with its title', async ({ page }) => {
  const text = `Wave 11 document post ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['li'],
      date: '2099-11-24',
      time: '09:00',
      format: 'IMAGE',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const post = await created.json();

  await page.goto('/signal?month=2099-11');
  const open = async () => {
    await page
      .getByRole('region', { name: '2099-11-24' })
      .getByRole('button', { name: `Edit ${text}` })
      .click();
  };
  await open();
  const editor = page.getByRole('dialog');

  await editor
    .getByLabel('Add a Drive file by link')
    .fill('https://drive.google.com/file/d/2PdFeFgHiJkLmNoPqRsTuVwXyZ0123456/view');
  await editor.getByRole('button', { name: 'Add Drive file' }).click();
  await expect(editor.getByText('e2e-drive-report.pdf')).toBeVisible();
  await expect(editor.getByText('application/pdf · 5 B')).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/signal/posts/${post.id}`) &&
        response.request().method() === 'PATCH' &&
        response.status() === 200,
    ),
    editor.getByRole('button', { name: 'Save post' }).click(),
  ]);
  await expect(editor).toBeHidden();

  await open();
  const linkedin = editor.locator('details[data-platform="linkedin"]');
  await linkedin.locator('summary').click();
  await linkedin.getByLabel(/^Title/).fill('The Q3 report');
  await editor.getByRole('button', { name: 'Save per-platform content' }).click();
  await expect(editor.getByRole('button', { name: 'Per-platform content saved' })).toBeVisible();

  await editor.getByRole('button', { name: 'Show preview' }).click();
  const preview = editor.getByRole('region', { name: 'Publish confirmation' });
  await expect(preview).toContainText('LinkedIn → @gholmes-designs · Ready to send');
  await expect(preview.getByRole('tabpanel')).toContainText('Title: The Q3 report');
  await preview.getByRole('button', { name: 'Confirm and submit' }).click();
  await expect(editor.getByRole('region', { name: 'Delivery' })).toContainText(
    'Accepted, not out yet',
  );

  // The PDF went as a fresh provider media id, and the title went with it as the document's.
  const publications = await (
    await page.request.get(`/api/signal/posts/${post.id}/publications`)
  ).json();
  expect(publications).toHaveLength(1);
  // The id is the mock provider's own counter, which every spec in the run shares, so what is
  // asserted is that one fresh id landed rather than which number it was.
  expect(publications[0].sentProviderMediaIds).toEqual([expect.stringMatching(/^mock-media-\d+$/)]);
  expect(publications[0]).toMatchObject({
    sentMediaSources: {
      version: 1,
      items: [{ source: 'DRIVE', driveName: 'e2e-drive-report.pdf', mimeType: 'application/pdf' }],
    },
  });
  // The document title itself is asserted where it is observable: on the preview panel above, and
  // on the wire in `post-bridge-wire.test.ts`, which maps it to the vendor's `document_title`. The
  // publication API deliberately exposes the media snapshot rather than the configuration blob.
});

test('an unverified thumbnail role is stored, version-bound, and not sent', async ({ page }) => {
  const text = `Wave 11 thumbnail role ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['yt'],
      mediaUrls: ['https://cdn.example.com/wave-11-talk.mp4'],
      date: '2099-11-25',
      time: '09:00',
      format: 'VIDEO',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const post = await created.json();

  await page.goto('/signal?month=2099-11');
  await page
    .getByRole('region', { name: '2099-11-25' })
    .getByRole('button', { name: `Edit ${text}` })
    .click();
  const editor = page.getByRole('dialog');

  const youtube = editor.locator('details[data-platform="youtube"]');
  await youtube.locator('summary').click();
  const thumbnail = youtube.locator('[data-role="THUMBNAIL"]');
  // The control says what it does today rather than implying a delivery nobody has watched.
  await expect(thumbnail).toContainText('has not verified that it is accepted');
  await thumbnail
    .getByLabel('Add a Drive file as the YouTube thumbnail')
    .fill('https://drive.google.com/file/d/3CoVeRgHiJkLmNoPqRsTuVwXyZ0123456/view');
  await thumbnail.getByRole('button', { name: 'Use this Drive file' }).click();
  await expect(thumbnail.getByText('e2e-drive-cover.png')).toBeVisible();
  await editor.getByRole('button', { name: 'Save per-platform content' }).click();
  await expect(editor.getByRole('button', { name: 'Per-platform content saved' })).toBeVisible();

  // Stored as a whole version-bound reference rather than as a URL string.
  const variants = await (await page.request.get(`/api/signal/posts/${post.id}/variants`)).json();
  expect(variants).toHaveLength(1);
  expect(variants[0]).toMatchObject({
    platform: 'youtube',
    thumbnail: {
      source: 'DRIVE',
      driveName: 'e2e-drive-cover.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      driveVersion: '7',
    },
  });

  await editor.getByRole('button', { name: 'Show preview' }).click();
  const panel = editor.getByRole('region', { name: 'Publish confirmation' }).getByRole('tabpanel');
  await expect(panel).toContainText('Thumbnail: Drive file · e2e-drive-cover.png');
  await expect(panel).toContainText('has not verified that it is accepted');

  // And the recheck a person asks for goes through the ordinary edit, so the confirmation it was
  // shown beside stops being current. Wait for the recheck response before asserting: on a loaded
  // Windows runner the round trip can outlast a bare click-and-expect.
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/variants/media/recheck') && response.status() === 200,
    ),
    thumbnail.getByRole('button', { name: 'Recheck thumbnail' }).click(),
  ]);
  await expect(editor.getByRole('region', { name: 'Publish confirmation' })).toBeHidden();
  await expect(editor.getByRole('button', { name: 'Show preview' })).toBeVisible();
});

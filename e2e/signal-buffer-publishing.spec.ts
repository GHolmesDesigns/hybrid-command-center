import { expect, test } from '@playwright/test';

/** Wave 15: one mocked Buffer post per target, partial reconciliation, and independent lifecycle. */
test('Buffer targets retain partial delivery, edit independently, cancel independently, and never move Signal', async ({
  page,
}) => {
  const text = `Wave 15 Buffer publishing ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['tt', 'yt'],
      date: '2099-10-18',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const createdPost = (await created.json()) as { id: string; revision: number };
  const postId = createdPost.id;

  const firstPreview = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  const listed = (await firstPreview.json()).connectedAccounts as {
    id: number;
    provider: string;
    platform: string;
  }[];
  const tiktok = listed.find(
    (target) => target.provider === 'buffer' && target.platform === 'tiktok',
  );
  const youtube = listed.find(
    (target) => target.provider === 'buffer' && target.platform === 'youtube',
  );
  expect(tiktok).toBeTruthy();
  expect(youtube).toBeTruthy();

  const selected = await page.request.put(`/api/signal/posts/${postId}/publish-targets`, {
    data: {
      revision: createdPost.revision,
      targets: [
        { channel: 'tt', providerAccountIds: [tiktok?.id] },
        { channel: 'yt', providerAccountIds: [youtube?.id] },
      ],
    },
  });
  expect(selected.ok()).toBe(true);
  const previewResponse = await page.request.post(`/api/signal/posts/${postId}/publish/preview`);
  const preview = await previewResponse.json();
  const submittedResponse = await page.request.post(`/api/signal/posts/${postId}/publish`, {
    data: { planHash: preview.planHash },
  });
  expect(submittedResponse.ok()).toBe(true);
  const submitted = await submittedResponse.json();
  expect(submitted.targets.map((target: { remotePostId?: string }) => target.remotePostId)).toEqual(
    ['mock-buffer-1', 'mock-buffer-2'],
  );

  const reconciledResponse = await page.request.post(
    `/api/signal/publications/${submitted.id}/reconcile`,
    { data: { automatic: false } },
  );
  const reconciled = await reconciledResponse.json();
  expect(reconciled.state).toBe('PARTIAL');

  const editedText = `${text} edited`;
  const currentPost = (await (await page.request.get(`/api/signal/posts/${postId}`)).json()) as {
    revision: number;
  };
  const editSignal = await page.request.patch(`/api/signal/posts/${postId}`, {
    data: { text: editedText, revision: currentPost.revision },
  });
  expect(editSignal.ok()).toBe(true);
  const contentPreviewResponse = await page.request.post(
    `/api/signal/publications/${submitted.id}/targets/${tiktok?.id}/provider/preview`,
  );
  const contentPreview = await contentPreviewResponse.json();
  expect(contentPreview.changed).toContain('caption');
  const edited = await page.request.post(
    `/api/signal/publications/${submitted.id}/targets/${tiktok?.id}/provider/apply`,
    { data: { action: 'UPDATE_CONTENT', reconcileHash: contentPreview.reconcileHash } },
  );
  expect(edited.ok()).toBe(true);

  const cancelPreviewResponse = await page.request.post(
    `/api/signal/publications/${submitted.id}/targets/${youtube?.id}/provider/preview`,
  );
  const cancelPreview = await cancelPreviewResponse.json();
  const cancelled = await page.request.post(
    `/api/signal/publications/${submitted.id}/targets/${youtube?.id}/provider/apply`,
    { data: { action: 'CANCEL', reconcileHash: cancelPreview.reconcileHash } },
  );
  expect(cancelled.ok()).toBe(true);

  const signal = await page.request.get(`/api/signal/posts/${postId}`);
  expect(await signal.json()).toMatchObject({
    id: postId,
    text: editedText,
    date: '2099-10-18',
    time: '09:00',
    status: 'SCHEDULED',
  });

  await page.goto('/signal?month=2099-10');
  await page
    .getByRole('region', { name: '2099-10-18' })
    .getByRole('button', { name: `Edit ${editedText}` })
    .click();
  const delivery = page.getByRole('dialog').getByRole('region', { name: 'Delivery' });
  await expect(delivery).toContainText('Partly delivered');
  await expect(delivery).toContainText('Cancelled in Buffer');
  await expect(page.getByRole('dialog').getByLabel('Planning status')).toHaveValue('SCHEDULED');
});

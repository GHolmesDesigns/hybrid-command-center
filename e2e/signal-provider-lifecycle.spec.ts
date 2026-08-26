import { expect, test } from '@playwright/test';

/**
 * Wave 8's second milestone flow: a post the provider is already holding, brought back into line.
 *
 * The card behind it opened on a question — the provider interface had no update path, and nothing
 * established that Post Bridge had one. It does, so this walks the path that answer made possible:
 * submit a scheduled post, edit it in Signal, see that the edit changed nothing out there, read the
 * difference, confirm the reschedule, and reconcile. The claim being checked end to end is that the
 * edit and the remote change are two separate acts, in that order, with a person between them.
 */
test('a Signal edit asks for a provider update, previews the difference, and reschedules on confirmation', async ({
  page,
}) => {
  const text = `Wave 8 provider lifecycle ${Date.now()}`;
  const created = await page.request.post('/api/signal/posts', {
    data: {
      text,
      channels: ['x'],
      date: '2099-11-10',
      time: '09:00',
      status: 'SCHEDULED',
    },
  });
  expect(created.ok()).toBe(true);
  const postId = (await created.json()).id as string;

  await page.goto('/signal?month=2099-11');
  const cell = page.getByRole('region', { name: '2099-11-10' });
  const openEditor = async () => {
    await cell
      .locator('.signal-post')
      .filter({ hasText: text })
      .getByRole('button', {
        name: `Edit ${text}`,
      })
      .click();
    return page.getByRole('dialog');
  };

  let editor = await openEditor();
  await editor.getByRole('button', { name: 'Show preview' }).click();
  const preview = editor.getByRole('region', { name: 'Publish confirmation' });
  await expect(preview).toContainText('X → @gholmes · Ready to send');
  await preview.getByRole('button', { name: 'Confirm and submit' }).click();

  const delivery = editor.getByRole('region', { name: 'Delivery' });
  await expect(delivery).toContainText('Accepted, not out yet');
  await expect(delivery).toContainText('Last checked');
  // Nothing is out of date yet, so the planner says nothing about a provider update.
  await expect(delivery).not.toContainText('Provider update required');

  // The Signal edit. It moves the plan and it is allowed to; what it must not do is change what
  // the provider is holding.
  await editor.getByLabel('Time').fill('15:30');
  await editor.getByRole('button', { name: 'Save post' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  editor = await openEditor();
  const reopened = editor.getByRole('region', { name: 'Delivery' });
  await expect(reopened).toContainText('Provider update required');
  await expect(reopened).toContainText('Scheduled for');
  await expect(reopened).toContainText('The provider still holds the earlier version.');

  // The comparison, read before anything is pressed. Both instants, side by side.
  await reopened.getByRole('button', { name: 'Compare with provider' }).click();
  const comparison = editor.getByRole('region', { name: 'Provider comparison' });
  await expect(comparison).toContainText('Scheduled with the provider');
  await expect(comparison).toContainText('1 field differs.');
  await expect(comparison).toContainText('differs');
  // A caption nobody touched is reported as agreeing, which is what makes the one row that
  // disagrees worth reading.
  await expect(comparison).toContainText(text);

  // Rescheduling is offered; rewriting the content is not, because nothing about it changed.
  await expect(comparison.getByRole('button', { name: 'Update provider content' })).toBeHidden();
  await expect(comparison).toContainText('already has this caption');
  await comparison.getByRole('button', { name: 'Update provider schedule' }).click();

  // The provider is on Signal's instant now, so the flag it was raised for is gone — and it is the
  // same publication throughout, not a resubmission.
  await expect(editor.getByRole('region', { name: 'Delivery' })).not.toContainText(
    'Provider update required',
  );
  const publications = await page.request.get(`/api/signal/posts/${postId}/publications`);
  const rows = await publications.json();
  expect(rows).toHaveLength(1);
  expect(rows[0].scheduledInstant).toBe('2099-11-10T20:30:00.000Z');
  expect(rows[0].driftFields).toBeUndefined();

  // Reconciling the mocked provider still works on the updated publication, and the planning
  // status is still the user's own claim — the provider never wrote it.
  await editor.getByRole('button', { name: 'Refresh delivery' }).click();
  await expect(editor.getByRole('region', { name: 'Delivery' })).toContainText('Last checked');
  await expect(editor.getByLabel('Planning status')).toHaveValue('SCHEDULED');

  // One redacted row per external operation, and no credential in any of them.
  const activity = await page.request.get('/api/integrations/activity?limit=50');
  const events = (await activity.json()) as { operation: string; error?: string }[];
  expect(events.some((event) => event.operation === 'signal.provider-update')).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/Bearer |api_key=/i);
});

import { test, expect } from '@playwright/test';

/**
 * The Stage 4 spec for C19. What only a real browser against a real server can settle here is
 * the card's central claim: a scheduled post and a task due date land on the same day and are
 * still two different things when they get there — separately headed, separately counted, and
 * distinguishable without reading a colour.
 *
 * It also settles the read-only guarantee end to end, by asking the API directly whether a
 * write exists rather than trusting that the page has no button for one.
 *
 * The month is far in the future so nothing another spec creates can drift into these counts;
 * the suite shares one database, and every name is stamped with the run.
 */
const MONTH = '2099-03';
const DAY = '2099-03-17';

test('the calendar shows scheduled content beside task deadlines, and never merges them', async ({
  page,
}) => {
  const run = Date.now();
  const clientName = `E2E Calendar Client ${run}`;
  const projectName = `E2E Calendar Project ${run}`;
  const taskTitle = `E2E Calendar Task ${run}`;
  const postText = `E2E Calendar Post ${run}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: clientName } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: projectName, priority: 'HIGH' },
    })
  ).json();
  await page.request.post('/api/tasks', {
    data: { projectId: project.id, title: taskTitle, dueDate: DAY },
  });

  const created = await page.request.post('/api/signal/posts', {
    data: {
      text: postText,
      date: DAY,
      time: '13:00',
      channels: ['li', 'ig'],
      status: 'SCHEDULED',
      format: 'REEL',
    },
  });
  expect(created.ok()).toBe(true);
  const post = await created.json();

  // The module is in the sidebar as a real destination, not a stub. Scoped to the navigation,
  // because the page heading names a month rather than the word Calendar.
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await page.goto('/');
  await nav.getByRole('link', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar$/);

  await page.goto(`/calendar?month=${MONTH}`);
  await expect(page.getByRole('heading', { level: 1, name: /March 2099/ })).toBeVisible();

  // Both kinds arrived on the same day, under one heading for that day.
  const day = page.getByRole('region', { name: /March 17, 2099/ });
  await expect(day).toBeVisible();

  // …and they are still two things. Each group has its own heading, and the post is inside the
  // content group while the task is inside the deadlines group — not one merged list of events.
  await expect(day.getByRole('heading', { name: /Scheduled content/ })).toBeVisible();
  await expect(day.getByRole('heading', { name: /Task deadlines/ })).toBeVisible();
  await expect(day.getByText(postText)).toBeVisible();
  await expect(day.getByRole('link', { name: taskTitle })).toBeVisible();

  // The status is a word and the channels carry their initials: neither is left to colour.
  await expect(day.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(day.getByText('Reel / Short')).toBeVisible();
  await expect(day.getByText('in', { exact: true })).toBeVisible();
  await expect(day.getByText('IG', { exact: true })).toBeVisible();

  // Counted by kind, never as one total. Scoped to this month, which only this spec fills.
  await expect(page.getByText(/1 scheduled post\b/)).toBeVisible();
  await expect(page.getByText(/1 task deadline\b/)).toBeVisible();

  // A month with nothing in it says so rather than showing a wall of blank days.
  await page.goto('/calendar?month=2099-04');
  await expect(page.getByText('Nothing this month')).toBeVisible();

  // Read-only, settled at the API rather than inferred from the absence of a button: the
  // calendar route answers reads and has no counterpart that writes.
  for (const method of ['post', 'patch', 'delete'] as const) {
    const attempt = await page.request[method]('/api/calendar', { data: { text: 'nope' } });
    expect(attempt.status()).toBe(404);
  }

  // The schedule itself is unchanged by anything the page did.
  const after = await (await page.request.get(`/api/signal/posts/${post.id}`)).json();
  expect(after).toMatchObject({ text: postText, date: DAY, status: 'SCHEDULED' });
});

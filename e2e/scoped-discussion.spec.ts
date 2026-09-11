import { test, expect } from '@playwright/test';

test('project discussions isolate threads and handoffs and stay in sync with Conversations', async ({
  page,
}) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Discussion Client ${run}` } })
  ).json();
  const projectOne = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Discussion One ${run}`, priority: 'HIGH' },
    })
  ).json();
  const projectTwo = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Discussion Two ${run}`, priority: 'MEDIUM' },
    })
  ).json();

  const firstTitle = `First project thread ${run}`;
  const secondTitle = `Second project thread ${run}`;
  await page.request.post('/api/agent-conversations', {
    data: { title: firstTitle, scope: { type: 'project', id: projectOne.id } },
  });
  await page.request.post('/api/agent-conversations', {
    data: { title: secondTitle, scope: { type: 'project', id: projectTwo.id } },
  });
  const handoffMessage = `Handoff for first project ${run}`;
  await page.request.post('/api/agent-handoffs', {
    data: {
      fromAgentLabel: 'e2e-agent',
      subjectType: 'project',
      subjectId: projectOne.id,
      message: handoffMessage,
    },
  });

  await page.goto(`/projects/${projectOne.id}`);
  const discussion = page.getByRole('region', { name: 'Threads' });
  await expect(discussion.getByText(firstTitle)).toBeVisible();
  await expect(discussion.getByText(secondTitle)).toBeHidden();
  await expect(discussion.getByText(handoffMessage)).toBeVisible();
  await expect(discussion.getByText('OPEN', { exact: true })).toBeVisible();

  const newTitle = `Inline project thread ${run}`;
  const reply = `Inline reply ${run}`;
  await discussion.getByLabel('Thread title').fill(newTitle);
  await discussion.getByRole('button', { name: 'Start thread' }).click();
  await expect(discussion.getByRole('heading', { level: 3, name: newTitle })).toBeVisible();
  await discussion.getByLabel('Reply').fill(reply);
  await discussion.getByRole('button', { name: 'Reply' }).click();
  await expect(discussion.getByText(reply)).toBeVisible();

  await discussion.getByRole('link', { name: 'Open all' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/agents/conversations\\?scopeType=project&scopeId=${projectOne.id}`),
  );
  const conversationList = page.getByRole('region', { name: 'Conversation list' });
  await expect(conversationList.getByText(newTitle)).toBeVisible();
  await expect(conversationList.getByText(secondTitle)).toBeHidden();
  await conversationList.getByRole('button', { name: new RegExp(newTitle) }).click();
  await expect(
    page.getByRole('region', { name: 'Conversation detail' }).getByText(reply),
  ).toBeVisible();

  await page.goto(`/projects/${projectTwo.id}`);
  const otherDiscussion = page.getByRole('region', { name: 'Threads' });
  await expect(otherDiscussion.getByText(secondTitle)).toBeVisible();
  await expect(otherDiscussion.getByText(firstTitle)).toBeHidden();
  await expect(otherDiscussion.getByText(newTitle)).toBeHidden();
  await expect(otherDiscussion.getByText(handoffMessage)).toBeHidden();
});

test('project thread @mention confirms a handoff and shows it on the message', async ({ page }) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `Mention Client ${run}` } })
  ).json();
  const project = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `Mention Project ${run}`, priority: 'HIGH' },
    })
  ).json();
  const title = `Mention thread ${run}`;
  const mentionBody = `@operator-session please review mention ${run}`;
  await page.request.post('/api/agent-conversations', {
    data: { title, scope: { type: 'project', id: project.id } },
  });

  await page.goto(`/projects/${project.id}`);
  const discussion = page.getByRole('region', { name: 'Threads' });
  await discussion.getByText(title).click();
  await discussion.getByLabel('Reply').fill(mentionBody);
  const handoffConfirm = discussion.getByRole('checkbox', {
    name: 'Open handoff to @operator-session',
  });
  await expect(handoffConfirm).toBeVisible();
  await expect(handoffConfirm).toBeChecked();
  await discussion.getByRole('button', { name: 'Reply' }).click();
  await expect(discussion.getByText(mentionBody)).toBeVisible();
  await expect(discussion.getByText('Handoff to @operator-session · OPEN')).toBeVisible();
});

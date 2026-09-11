import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, MemoryRouter } from './App.test-setup';
import { DiscussionPanel } from './components/DiscussionPanel';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const page = (items: unknown[]) => ({ items, nextCursor: null, hasMore: false });
const handoffPage = (handoffs: unknown[]) => ({ handoffs, limit: 20, offset: 0, truncated: false });

const conversation = {
  id: 'c1',
  title: 'Launch notes',
  messageCount: 1,
  updatedAt: '2026-09-10T12:00:00Z',
  state: 'ACTIVE',
};
const handoff = {
  id: 'h1',
  createdAt: '2026-09-10T11:00:00Z',
  updatedAt: '2026-09-10T11:00:00Z',
  fromAgentLabel: 'cursor',
  fromAgentProvenance: 'ASSERTED',
  toAgentLabel: null,
  subjectType: 'project',
  subjectId: 'p1',
  message: 'Review the project brief.',
  state: 'OPEN',
  claimedBy: null,
  claimedByProvenance: null,
  claimedAt: null,
  completedAt: null,
  completedByProvenance: null,
  cancelledAt: null,
  cancelReason: null,
  clientRequestId: null,
};

describe('DiscussionPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads only the bound subject threads and handoffs, then keeps an inline reply visible', async () => {
    let replyBody: unknown;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agent-handoffs?')) return json(handoffPage([handoff]));
      if (url.includes('/agent-conversations/c1/messages') && init?.method === 'POST') {
        replyBody = JSON.parse(String(init.body));
        return json(
          {
            id: 'm2',
            senderLabel: 'operator',
            sentAt: '2026-09-10T12:01:00Z',
            body: 'Reply',
          },
          201,
        );
      }
      if (url.includes('/agent-conversations/c1/messages')) {
        return json(
          page([{ id: 'm1', senderLabel: 'agent', sentAt: '2026-09-10T12:00:00Z', body: 'Hello' }]),
        );
      }
      if (url.includes('/agent-conversations?')) return json(page([conversation]));
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <MemoryRouter>
        <DiscussionPanel
          scopeType="project"
          scopeId="p1"
          subjectLabel="Project One"
          subjectPath="/projects/p1"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Launch notes')).toBeVisible();
    expect(await screen.findByText('Review the project brief.')).toBeVisible();
    expect(screen.getByText('OPEN')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-conversations?state=ACTIVE&scopeType=project&scopeId=p1',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent-handoffs?subjectType=project&subjectId=p1&limit=20',
      expect.any(Object),
    );

    fireEvent.click(screen.getByRole('button', { name: /Launch notes/ }));
    expect(await screen.findByText('Hello')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(screen.getByText('Reply', { selector: 'p' })).toBeVisible());
    await waitFor(() => expect(replyBody).toMatchObject({ body: 'Reply', confirmHandoffs: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to threads' }));
    expect(screen.getByLabelText('Thread title')).toBeVisible();
  });

  it('starts an empty discussion with a locked workspace scope', async () => {
    let createBody: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agent-handoffs?')) return json(handoffPage([]));
      if (url.endsWith('/api/agent-conversations') && init?.method === 'POST') {
        createBody = JSON.parse(String(init.body));
        return json({ ...conversation, id: 'c2', title: 'New thread', messageCount: 0 }, 201);
      }
      if (url.includes('/agent-conversations/c2/messages')) return json(page([]));
      if (url.includes('/agent-conversations?')) return json(page([]));
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <MemoryRouter>
        <DiscussionPanel
          scopeType="task"
          scopeId="t1"
          subjectLabel="Task One"
          subjectPath="/tasks/t1"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/No discussion yet/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Task One' }).parentElement).toHaveTextContent(
      'Scope: Task One (Task, locked)',
    );
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Thread title'), { target: { value: ' New thread ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start thread' }));

    expect(await screen.findByRole('heading', { level: 3, name: 'New thread' })).toBeVisible();
    expect(createBody).toEqual({
      title: 'New thread',
      scope: { type: 'task', id: 't1' },
    });
  });

  it('reports a failed discussion read instead of claiming the scope is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agent-handoffs?')) return json(handoffPage([]));
      return json({ error: 'Conversation store unavailable.' }, 503);
    });

    render(
      <MemoryRouter>
        <DiscussionPanel
          scopeType="client"
          scopeId="client-1"
          subjectLabel="Client One"
          subjectPath="/clients/client-1"
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Conversation store unavailable.');
    expect(screen.queryByText(/No discussion yet/)).not.toBeInTheDocument();
  });
});

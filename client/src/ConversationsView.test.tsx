import { ConversationsView } from './components/ConversationsView';
import {
  afterEach,
  describe,
  expect,
  fireEvent,
  it,
  MemoryRouter,
  render,
  screen,
  waitFor,
  vi,
} from './App.test-setup';

describe('ConversationsView', () => {
  afterEach(() => vi.restoreAllMocks());
  it('opens the newest messages, posts an operator reply, and archives', async () => {
    const conversation = {
      id: 'c1',
      title: 'Review',
      state: 'ACTIVE',
      scope: { type: 'freeform', id: null },
      participants: ['cursor'],
      messageCount: 1,
      updatedAt: '2026-09-10T12:00:00Z',
    };
    const message = {
      id: 'm1',
      senderLabel: 'cursor',
      sentAt: '2026-09-10T12:00:00Z',
      body: 'Hello',
      provenance: 'ASSERTED',
    };
    const olderMessage = {
      ...message,
      id: 'm0',
      sentAt: '2026-09-10T11:00:00Z',
      body: 'Earlier context',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/messages') && init?.method === 'POST')
        return new Response(
          JSON.stringify({
            ...message,
            id: 'm2',
            senderLabel: 'operator',
            body: 'Reply',
            provenance: 'VERIFIED',
          }),
          { status: 201 },
        );
      if (url.includes('/archive'))
        return new Response(JSON.stringify({ ...conversation, state: 'ARCHIVED' }));
      if (url.includes('/messages') && url.includes('cursor=older'))
        return new Response(
          JSON.stringify({ items: [olderMessage], nextCursor: null, hasMore: false }),
        );
      if (url.includes('/messages'))
        return new Response(
          JSON.stringify({ items: [message], nextCursor: 'older', hasMore: true }),
        );
      return new Response(
        JSON.stringify({ items: [conversation], nextCursor: null, hasMore: false }),
      );
    });
    render(
      <MemoryRouter>
        <ConversationsView flash={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Review')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    expect(await screen.findByText('Hello')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('Earlier context')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Reply')).toBeVisible();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    expect(await screen.findByText('Review')).toBeVisible();
    expect(screen.getByLabelText('Conversation state')).toHaveValue('ACTIVE');
  });

  it('carries a detail-page scope into the server-side conversation list query', async () => {
    const scopedConversation = {
      id: 'task-thread',
      title: 'Task discussion',
      state: 'ACTIVE',
      scope: { type: 'task', id: 'task 1' },
      participants: ['cursor'],
      messageCount: 0,
      updatedAt: '2026-09-10T12:00:00Z',
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ items: [scopedConversation], nextCursor: null, hasMore: false }),
          ),
      );

    render(
      <MemoryRouter initialEntries={['/agents/conversations?scopeType=task&scopeId=task%201']}>
        <ConversationsView flash={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Showing task discussion/)).toBeVisible();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agent-conversations?state=ACTIVE&scopeType=task&scopeId=task%201',
        expect.any(Object),
      ),
    );
    expect(screen.getByRole('link', { name: 'Show every conversation' })).toHaveAttribute(
      'href',
      '/agents/conversations',
    );
    expect(screen.getByRole('link', { name: 'Task: task 1' })).toHaveAttribute(
      'href',
      '/tasks/task%201',
    );

    fireEvent.change(screen.getByLabelText('Conversation state'), {
      target: { value: 'ARCHIVED' },
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agent-conversations?state=ARCHIVED&scopeType=task&scopeId=task%201',
        expect.any(Object),
      ),
    );
  });
});

import { act } from '@testing-library/react';
import { AgentHubTipsContext } from './components/AgentHubTipsContext';
import { ConversationsView } from './components/ConversationsView';
import type { AgentHubTipPayload } from '../../shared/agent-hub-sse';
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

  it('marks a thread as a decision, edits its outcome, filters it, and clears the mark', async () => {
    let current = {
      id: 'decision-thread',
      title: 'Decision thread',
      state: 'ACTIVE',
      scope: { type: 'freeform', id: null },
      participants: ['cursor'],
      messageCount: 0,
      updatedAt: '2026-09-10T12:00:00Z',
      isDecision: false,
      decisionOutcome: null as string | null,
      decidedAt: null as string | null,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return new Response(JSON.stringify({ agents: [] }));
      if (url.includes('/messages'))
        return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }));
      if (url.endsWith('/decision/clear') && init?.method === 'POST') {
        current = { ...current, isDecision: false, decisionOutcome: null, decidedAt: null };
        return new Response(JSON.stringify(current));
      }
      if (url.endsWith('/decision') && init?.method === 'POST') {
        const { outcome } = JSON.parse(String(init.body)) as { outcome: string };
        current = {
          ...current,
          isDecision: true,
          decisionOutcome: outcome.trim() || null,
          decidedAt: current.decidedAt ?? '2026-09-10T12:01:00Z',
        };
        return new Response(JSON.stringify(current));
      }
      return new Response(JSON.stringify({ items: [current], nextCursor: null, hasMore: false }));
    });

    render(
      <MemoryRouter>
        <ConversationsView flash={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Decision thread/ }));
    fireEvent.change(screen.getByLabelText('Decision outcome'), {
      target: { value: '  Use the approved plan.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as decision' }));
    expect(await screen.findByText('Outcome: Use the approved plan.')).toBeVisible();
    expect(screen.getByText('Decision: Use the approved plan.')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Decision outcome'), {
      target: { value: 'Ship the revised plan.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }));
    expect(await screen.findByText('Outcome: Ship the revised plan.')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Conversation state'), {
      target: { value: 'DECISIONS' },
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agent-conversations?isDecision=true',
        expect.any(Object),
      ),
    );
    expect(screen.getByText('Decision: Ship the revised plan.')).toBeVisible();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear decision mark' }));
    expect(await screen.findByRole('button', { name: 'Mark as decision' })).toBeVisible();
    expect(screen.queryByText('Decision: Ship the revised plan.')).not.toBeInTheDocument();
  });

  it('rereads the open thread when a matching live tip arrives', async () => {
    const conversation = {
      id: 'live-thread',
      title: 'Live thread',
      state: 'ACTIVE',
      scope: { type: 'freeform', id: null },
      participants: ['cursor'],
      messageCount: 1,
      updatedAt: '2026-09-10T12:00:00Z',
      isDecision: false,
      decisionOutcome: null,
      decidedAt: null,
    };
    const firstMessage = {
      id: 'm1',
      senderLabel: 'cursor',
      sentAt: '2026-09-10T12:00:00Z',
      body: 'First',
      provenance: 'ASSERTED',
    };
    const secondMessage = {
      ...firstMessage,
      id: 'm2',
      body: 'Second',
    };
    let messageReads = 0;
    let emitTip: ((tip: AgentHubTipPayload) => void) | null = null;
    const subscribe = (listener: (tip: AgentHubTipPayload) => void) => {
      emitTip = listener;
      return () => {
        emitTip = null;
      };
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return new Response(JSON.stringify({ agents: [] }));
      if (url.includes('/agents/presence')) return new Response(JSON.stringify({ presence: [] }));
      if (url.includes('/agent-summaries')) return new Response(JSON.stringify({ summaries: [] }));
      if (url.includes('/messages')) {
        messageReads += 1;
        return new Response(
          JSON.stringify({
            items: [messageReads > 1 ? secondMessage : firstMessage],
            nextCursor: null,
            hasMore: false,
          }),
        );
      }
      return new Response(JSON.stringify({ items: [conversation], nextCursor: null, hasMore: false }));
    });

    render(
      <MemoryRouter>
        <AgentHubTipsContext.Provider value={subscribe}>
          <ConversationsView flash={vi.fn()} liveTipsEnabled />
        </AgentHubTipsContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Live thread/ }));
    expect(await screen.findByText('First')).toBeVisible();

    act(() => {
      emitTip?.({ feeds: ['conversations'], conversationId: 'other-thread' });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(screen.getByText('First')).toBeVisible();

    act(() => {
      emitTip?.({ feeds: ['conversations'], conversationId: 'live-thread' });
    });
    expect(await screen.findByText('Second', {}, { timeout: 2000 })).toBeVisible();
  });
});

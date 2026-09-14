import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CommandAiFab, CommandAiPanel, CommandAiTopbarToggle } from './components/CommandAiPanel';
import { ConversationSelectionProvider } from './components/ConversationSelectionProvider';

function renderPanel(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <ConversationSelectionProvider>{ui}</ConversationSelectionProvider>
    </MemoryRouter>,
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const freeformConversation = (id: string, title: string) => ({
  id,
  title,
  state: 'ACTIVE' as const,
  scope: { type: 'freeform' as const, id: null },
  participants: ['operator'],
  messageCount: 1,
  updatedAt: '2026-09-10T12:00:00.000Z',
});

describe('CommandAiPanel', () => {
  it('starts a freeform thread from the compose field', async () => {
    let createBody: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/agents/directory'))
        return json({
          agents: [{ label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' }],
        });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?'))
        return json({ items: [], nextCursor: null, hasMore: false });
      if (url.endsWith('/api/agent-conversations') && init?.method === 'POST') {
        createBody = JSON.parse(String(init.body));
        return json(
          {
            id: 'conv-1',
            title: 'Queue health question',
            state: 'ACTIVE',
            scope: { type: 'freeform', id: null },
            participants: ['operator'],
            messageCount: 0,
            updatedAt: '2026-09-11T12:00:00.000Z',
          },
          201,
        );
      }
      if (url.includes('/agent-conversations/conv-1/messages') && init?.method === 'POST') {
        return json({
          id: 'm1',
          senderLabel: 'operator',
          sentAt: '2026-09-11T12:00:01.000Z',
          body: 'Queue health question',
          thoughtSummary: null,
          provenance: 'VERIFIED',
          linkedHandoffs: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderPanel(<CommandAiPanel open onClose={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Command AI message'), {
      target: { value: 'Queue health question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(createBody).toEqual({
        title: 'Queue health question',
        scope: { type: 'freeform' },
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Queue health question' }),
    ).toBeVisible();
    expect(screen.getAllByText('Queue health question').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the floating opener when the panel is collapsed', () => {
    render(<CommandAiFab open={false} onClick={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Open Command AI' })).toBeVisible();
  });

  it('lists history and returns to a saved thread', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({
          items: [
            {
              id: 'conv-history',
              title: 'Prior inquiry',
              state: 'ACTIVE',
              scope: { type: 'freeform', id: null },
              participants: ['operator'],
              messageCount: 1,
              updatedAt: '2026-09-10T12:00:00.000Z',
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-history/messages')) {
        return json({
          items: [
            {
              id: 'm-old',
              senderLabel: 'operator',
              sentAt: '2026-09-10T12:00:01.000Z',
              body: 'Prior inquiry',
              thoughtSummary: null,
              provenance: 'VERIFIED',
              linkedHandoffs: [],
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });

    renderPanel(<CommandAiPanel open onClose={() => undefined} />);

    expect(await screen.findByText('Prior inquiry')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByRole('heading', { name: 'Chat history' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Prior inquiry/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Prior inquiry' })).toBeVisible();
  });

  it('clears the active thread when New is pressed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({ items: [], nextCursor: null, hasMore: false });
      }
      if (url.endsWith('/api/agent-conversations') && init?.method === 'POST') {
        return json(
          {
            id: 'conv-new',
            title: 'Fresh question',
            state: 'ACTIVE',
            scope: { type: 'freeform', id: null },
            participants: ['operator'],
            messageCount: 0,
            updatedAt: '2026-09-11T12:00:00.000Z',
          },
          201,
        );
      }
      if (url.includes('/agent-conversations/conv-new/messages') && init?.method === 'POST') {
        return json({
          id: 'm-new',
          senderLabel: 'operator',
          sentAt: '2026-09-11T12:00:01.000Z',
          body: 'Fresh question',
          thoughtSummary: null,
          provenance: 'VERIFIED',
          linkedHandoffs: [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderPanel(<CommandAiPanel open onClose={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Command AI message'), {
      target: { value: 'Fresh question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Fresh question' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(await screen.findByText('What are you curious about?')).toBeVisible();
    expect(screen.queryByRole('heading', { level: 3, name: 'Fresh question' })).toBeNull();
  });

  it('calls onClose from the panel header', async () => {
    const onClose = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({ items: [], nextCursor: null, hasMore: false });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderPanel(<CommandAiPanel open onClose={onClose} />);

    await screen.findByText('What are you curious about?');
    fireEvent.click(screen.getByRole('button', { name: 'Close Command AI' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the topbar toggle in active state', () => {
    const onClick = vi.fn();
    render(<CommandAiTopbarToggle open onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /Command AI/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps conversation reads bounded after selecting a recent thread', async () => {
    let listReads = 0;
    let messageReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        listReads += 1;
        return json({
          items: [freeformConversation('conv-loop', 'Loop thread')],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-loop/messages')) {
        messageReads += 1;
        return json({
          items: [
            {
              id: 'm-loop',
              senderLabel: 'operator',
              sentAt: '2026-09-10T12:00:01.000Z',
              body: 'Loop thread',
              thoughtSummary: null,
              provenance: 'VERIFIED',
              linkedHandoffs: [],
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderPanel(<CommandAiPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: /Loop thread/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Loop thread' })).toBeVisible();
    expect(listReads).toBeLessThanOrEqual(2);
    expect(messageReads).toBe(1);
  });

  it('returns to empty chat from Recent and from the thread back control', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({
          items: [freeformConversation('conv-recent', 'Recent thread')],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-recent/messages')) {
        return json({
          items: [
            {
              id: 'm-recent',
              senderLabel: 'operator',
              sentAt: '2026-09-10T12:00:01.000Z',
              body: 'Recent thread',
              thoughtSummary: null,
              provenance: 'VERIFIED',
              linkedHandoffs: [],
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderPanel(<CommandAiPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: /Recent thread/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Recent thread' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(await screen.findByText('What are you curious about?')).toBeVisible();
    expect(screen.queryByRole('heading', { level: 3, name: 'Recent thread' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Recent thread/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Recent thread' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '← New chat' }));
    expect(await screen.findByText('What are you curious about?')).toBeVisible();
  });

  it('discards a stale message response after New chat', async () => {
    let resolveMessages: ((response: Response) => void) | undefined;
    const messagesPromise = new Promise<Response>((resolve) => {
      resolveMessages = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({
          items: [freeformConversation('conv-stale', 'Stale thread')],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-stale/messages')) {
        return messagesPromise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderPanel(<CommandAiPanel open onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: /Stale thread/ }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Stale thread' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '← New chat' }));
    expect(await screen.findByText('What are you curious about?')).toBeVisible();

    resolveMessages?.(
      json({
        items: [
          {
            id: 'm-stale',
            senderLabel: 'operator',
            sentAt: '2026-09-10T12:00:01.000Z',
            body: 'Should not reappear',
            thoughtSummary: null,
            provenance: 'VERIFIED',
            linkedHandoffs: [],
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    );

    expect(screen.queryByText('Should not reappear')).toBeNull();
    expect(screen.getByText('What are you curious about?')).toBeVisible();
  });

  it('shows a refresh error and offers view all for long history', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({
          items: Array.from({ length: 6 }, (_, index) => ({
            id: `conv-${index}`,
            title: `Thread ${index}`,
            state: 'ACTIVE',
            scope: { type: 'freeform', id: null },
            participants: ['operator'],
            messageCount: 0,
            updatedAt: `2026-09-1${index}T12:00:00.000Z`,
          })),
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    renderPanel(<CommandAiPanel open onClose={() => undefined} />);

    expect(await screen.findByText('Thread 0')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'View all' }));
    expect(await screen.findByRole('heading', { name: 'Chat history' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: /Thread/ })).toHaveLength(6);
  });
});

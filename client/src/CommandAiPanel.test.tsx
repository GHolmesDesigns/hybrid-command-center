import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CommandAiFab, CommandAiPanel, CommandAiTopbarToggle } from './components/CommandAiPanel';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

    render(
      <MemoryRouter>
        <CommandAiPanel open onClose={() => undefined} />
      </MemoryRouter>,
    );

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

    render(
      <MemoryRouter>
        <CommandAiPanel open onClose={() => undefined} />
      </MemoryRouter>,
    );

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

    render(
      <MemoryRouter>
        <CommandAiPanel open onClose={() => undefined} />
      </MemoryRouter>,
    );

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

    render(
      <MemoryRouter>
        <CommandAiPanel open onClose={onClose} />
      </MemoryRouter>,
    );

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
});

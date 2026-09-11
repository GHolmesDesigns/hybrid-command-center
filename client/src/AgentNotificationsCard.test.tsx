import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from './App.test-setup';
import { AgentNotificationsCard } from './components/AgentNotificationsCard';
import { MemoryRouter } from 'react-router-dom';

describe('agent notifications card', () => {
  afterEach(() => vi.restoreAllMocks());
  it('shows the exact unread count and mark-all control', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          notifications: [
            {
              id: 'n1',
              incidentKey: 'i1',
              kind: 'test',
              agentLabel: 'reviewer',
              title: 'Needs review',
              body: 'Please review this.',
              createdAt: '2026-09-10T12:00:00.000Z',
              readAt: null,
              destination: { type: 'agents', id: 'reviewer' },
            },
          ],
          unreadCount: 4,
          nextCursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    render(
      <MemoryRouter>
        <AgentNotificationsCard flash={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Needs review')).toBeVisible();
    expect(screen.getByLabelText('4 unread notifications')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeEnabled();
    expect(screen.getAllByRole('link', { name: 'Open destination' })[0]).toHaveAttribute(
      'href',
      '/agents#agent-directory',
    );
  });

  it('marks all read and supports the all-notifications filter', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ notifications: [], unreadCount: 0, nextCursor: null }), {
        status: 200,
      }),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ marked: 0 }), { status: 200 }));
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ notifications: [], unreadCount: 0, nextCursor: null }), {
        status: 200,
      }),
    );
    render(
      <MemoryRouter>
        <AgentNotificationsCard flash={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No notifications match this filter.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    fireEvent.change(screen.getByLabelText('Notification filter'), { target: { value: 'false' } });
    expect(await screen.findByText('No notifications match this filter.')).toBeVisible();
  });

  it('marks one notification read and loads the next page', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const row = {
      id: 'n2',
      incidentKey: 'i2',
      kind: 'test',
      agentLabel: 'reviewer',
      title: 'Read me',
      body: 'Body',
      createdAt: '2026-09-10T12:00:00.000Z',
      readAt: null,
      destination: null,
    };
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ notifications: [row], unreadCount: 1, nextCursor: 'cursor' }), {
        status: 200,
      }),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(row), { status: 200 }));
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          notifications: [{ ...row, id: 'n3', title: 'Older' }],
          unreadCount: 0,
          nextCursor: null,
        }),
        { status: 200 },
      ),
    );
    render(
      <MemoryRouter>
        <AgentNotificationsCard flash={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Read me')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Older')).toBeVisible();
  });

  it('links every supported destination and omits links when absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          notifications: [
            {
              id: 'conversation',
              incidentKey: 'i',
              kind: 'test',
              agentLabel: 'a',
              title: 'Conversation',
              body: 'b',
              createdAt: '2026-09-10T12:00:00.000Z',
              readAt: 'now',
              destination: { type: 'conversation', id: 'c' },
            },
            {
              id: 'memory',
              incidentKey: 'i',
              kind: 'test',
              agentLabel: 'a',
              title: 'Memory',
              body: 'b',
              createdAt: '2026-09-10T12:00:00.000Z',
              readAt: 'now',
              destination: { type: 'memory', id: 'm' },
            },
            {
              id: 'handoff',
              incidentKey: 'i',
              kind: 'test',
              agentLabel: 'a',
              title: 'Handoff',
              body: 'b',
              createdAt: '2026-09-10T12:00:00.000Z',
              readAt: 'now',
              destination: { type: 'handoff', id: 'h' },
            },
            {
              id: 'none',
              incidentKey: 'i',
              kind: 'test',
              agentLabel: 'a',
              title: 'No destination',
              body: 'b',
              createdAt: '2026-09-10T12:00:00.000Z',
              readAt: 'now',
              destination: null,
            },
          ],
          unreadCount: 0,
          nextCursor: null,
        }),
        { status: 200 },
      ),
    );
    render(
      <MemoryRouter>
        <AgentNotificationsCard flash={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Conversation')).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Open destination' })).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: 'Open destination' })[0]).toHaveAttribute(
      'href',
      '/agents/conversations',
    );
    expect(screen.getAllByRole('link', { name: 'Open destination' })[2]).toHaveAttribute(
      'href',
      '/agents?handoff=h#agent-handoffs',
    );
  });
});

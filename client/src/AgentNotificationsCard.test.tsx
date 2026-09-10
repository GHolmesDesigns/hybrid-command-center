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
    expect(screen.getByRole('link', { name: 'Open destination' })).toHaveAttribute(
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
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, MemoryRouter } from './App.test-setup';
import { DiscussionPanel } from './components/DiscussionPanel';

const page = (items: unknown[]) =>
  new Response(JSON.stringify({ items, nextCursor: null, hasMore: false }), { status: 200 });

describe('DiscussionPanel', () => {
  afterEach(() => vi.restoreAllMocks());
  it('loads scoped threads, starts one, and replies inline', async () => {
    const conversation = {
      id: 'c1',
      title: 'Launch notes',
      messageCount: 1,
      updatedAt: '2026-09-10T12:00:00Z',
      state: 'ACTIVE',
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page([conversation]))
      .mockResolvedValueOnce(
        page([{ id: 'm1', senderLabel: 'agent', sentAt: '2026-09-10T12:00:00Z', body: 'Hello' }]),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(conversation), { status: 201 }))
      .mockResolvedValueOnce(page([conversation]))
      .mockResolvedValueOnce(
        page([{ id: 'm1', senderLabel: 'agent', sentAt: '2026-09-10T12:00:00Z', body: 'Hello' }]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'm2',
            senderLabel: 'operator',
            sentAt: '2026-09-10T12:01:00Z',
            body: 'Reply',
          }),
          { status: 201 },
        ),
      );
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
    fireEvent.click(screen.getByRole('button', { name: /Launch notes/ }));
    expect(await screen.findByText('Hello')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Discussion reply'), { target: { value: 'Reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agent-conversations/c1/messages',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CommandAiFab, CommandAiPanel } from './components/CommandAiPanel';

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
      if (url.includes('/agents/directory')) return json({ agents: [{ label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' }] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) return json({ items: [], nextCursor: null, hasMore: false });
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
    expect(await screen.findByRole('heading', { level: 3, name: 'Queue health question' })).toBeVisible();
    expect(screen.getAllByText('Queue health question').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the floating opener when the panel is collapsed', () => {
    render(<CommandAiFab open={false} onClick={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Open Command AI' })).toBeVisible();
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CommandAiPanel } from './components/CommandAiPanel';
import { ConversationSelectionProvider } from './components/ConversationSelectionProvider';
import { ConversationsView } from './components/ConversationsView';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function ConversationsWithDrawer({
  initialEntry = '/agents/conversations',
  drawerOpen = true,
}: {
  initialEntry?: string;
  drawerOpen?: boolean;
}) {
  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <ConversationSelectionProvider>
        <Routes>
          <Route
            path="/agents/conversations"
            element={
              <>
                <ConversationsView flash={vi.fn()} />
                <CommandAiPanel open={drawerOpen} onClose={() => undefined} />
              </>
            }
          />
        </Routes>
      </ConversationSelectionProvider>
    </MemoryRouter>
  );
}

const freeformConversation = (id: string, title: string) => ({
  id,
  title,
  state: 'ACTIVE' as const,
  scope: { type: 'freeform' as const, id: null },
  participants: ['operator'],
  messageCount: 1,
  updatedAt: '2026-09-10T12:00:00.000Z',
  isDecision: false,
  decisionOutcome: null,
  decidedAt: null,
});

describe('conversation drawer and full-view sync', () => {
  it('updates the URL and full detail when the drawer selects a thread', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({
          items: [
            freeformConversation('conv-a', 'Thread A'),
            freeformConversation('conv-b', 'Thread B'),
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-a/messages')) {
        return json({
          items: [
            {
              id: 'm-a',
              senderLabel: 'operator',
              sentAt: '2026-09-10T12:00:01.000Z',
              body: 'Message A',
              provenance: 'VERIFIED',
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-b/messages')) {
        return json({
          items: [
            {
              id: 'm-b',
              senderLabel: 'operator',
              sentAt: '2026-09-10T12:00:02.000Z',
              body: 'Message B',
              provenance: 'VERIFIED',
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ConversationsWithDrawer initialEntry="/agents/conversations?open=conv-a" />);

    expect((await screen.findAllByText('Message A')).length).toBeGreaterThanOrEqual(1);
    const drawer = screen.getByRole('complementary', { name: 'Command AI' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'History' }));
    fireEvent.click(within(drawer).getByRole('button', { name: /Thread B/ }));
    expect((await screen.findAllByText('Message B')).length).toBeGreaterThanOrEqual(1);
    expect(within(drawer).getByRole('heading', { level: 3, name: 'Thread B' })).toBeVisible();
    expect(within(drawer).getByRole('link', { name: 'Open full view' })).toHaveAttribute(
      'href',
      '/agents/conversations?open=conv-b',
    );
  });

  it('follows full-view selection in the drawer without closing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({
          items: [
            freeformConversation('conv-a', 'Thread A'),
            freeformConversation('conv-b', 'Thread B'),
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-a/messages')) {
        return json({
          items: [
            {
              id: 'm-a',
              senderLabel: 'operator',
              sentAt: '2026-09-10T12:00:01.000Z',
              body: 'Message A',
              provenance: 'VERIFIED',
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-b/messages')) {
        return json({
          items: [
            {
              id: 'm-b',
              senderLabel: 'operator',
              sentAt: '2026-09-10T12:00:02.000Z',
              body: 'Message B',
              provenance: 'VERIFIED',
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ConversationsWithDrawer initialEntry="/agents/conversations?open=conv-a" />);

    expect((await screen.findAllByText('Message A')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { level: 3, name: 'Thread A' })).toBeVisible();

    fireEvent.click(screen.getAllByRole('button', { name: /Thread B/ })[0]!);
    expect((await screen.findAllByText('Message B')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', { level: 3, name: 'Thread B' })).toBeVisible();
    expect(screen.getByRole('complementary', { name: 'Command AI' })).toBeVisible();
  });

  it('shows a scoped-thread explanation in the drawer instead of another thread', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/agents/directory')) return json({ agents: [] });
      if (url.includes('/agents/presence')) return json({ presence: [] });
      if (url.includes('/agent-summaries')) return json({ summaries: [] });
      if (url.includes('/agent-conversations?')) {
        return json({
          items: [
            {
              ...freeformConversation('conv-free', 'Freeform thread'),
            },
            {
              id: 'conv-scoped',
              title: 'Project thread',
              state: 'ACTIVE',
              scope: { type: 'project', id: 'project-1' },
              participants: ['operator'],
              messageCount: 0,
              updatedAt: '2026-09-10T12:00:00.000Z',
              isDecision: false,
              decisionOutcome: null,
              decidedAt: null,
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (url.includes('/agent-conversations/conv-free/messages')) {
        return json({ items: [], nextCursor: null, hasMore: false });
      }
      if (url.includes('/agent-conversations/conv-scoped/messages')) {
        return json({ items: [], nextCursor: null, hasMore: false });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<ConversationsWithDrawer initialEntry="/agents/conversations?open=conv-scoped" />);

    expect(await screen.findByText('Project thread')).toBeVisible();
    expect(await screen.findByText(/Command AI shows active freeform threads only/i)).toBeVisible();
    expect(screen.queryByRole('heading', { level: 3, name: 'Freeform thread' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open full view' })).toHaveAttribute(
      'href',
      '/agents/conversations?open=conv-scoped',
    );
  });
});

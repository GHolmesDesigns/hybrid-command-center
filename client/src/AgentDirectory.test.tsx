import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from './App.test-setup';
import { AgentDirectoryCard } from './components/AgentDirectoryCard';

const response = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

describe('Agent directory', () => {
  it('renders trusted capabilities and availability history without credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        response({
          agents: [
            {
              id: 'a1',
              label: 'reviewer',
              displayName: 'Review Agent',
              bio: 'Reviews changes.',
              trustLevel: 'VERIFIED',
              availability: 'CURRENT',
              capabilities: [{ name: 'code-review', description: 'Reviews code.' }],
            },
            {
              id: 'a2',
              label: 'offline',
              displayName: 'Offline Agent',
              bio: null,
              trustLevel: 'UNVERIFIED',
              availability: 'HISTORICAL',
              capabilities: [],
            },
          ],
        }),
      ),
    );
    render(<AgentDirectoryCard />);
    expect(await screen.findByText('Review Agent')).toBeVisible();
    expect(screen.getByText('Verified recently')).toBeVisible();
    expect(screen.getByText('Historical availability')).toBeVisible();
    expect(screen.getByText('code-review')).toBeVisible();
    expect(screen.queryByText(/token/i)).toBeNull();
  });

  it('renders empty and error states', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response({ agents: [] })),
    );
    const { unmount } = render(<AgentDirectoryCard />);
    expect(await screen.findByText('No agents registered')).toBeVisible();
    unmount();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response({ error: 'Directory unavailable.' }, false)),
    );
    render(<AgentDirectoryCard />);
    await waitFor(() => expect(screen.getByText('Directory unavailable.')).toBeVisible());
  });

  it('renders live presence and summaries, filters labels, and re-checks', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/agents/directory')) {
        return response({
          agents: [
            {
              id: 'a1',
              label: 'reviewer',
              displayName: 'Review Agent',
              trustLevel: 'VERIFIED',
              availability: 'CURRENT',
              capabilities: [],
            },
            {
              id: 'a2',
              label: 'quiet',
              displayName: 'Quiet Agent',
              trustLevel: 'UNVERIFIED',
              availability: 'CURRENT',
              capabilities: [],
            },
          ],
        });
      }
      if (url.includes('/agents/presence')) {
        return response({
          presence: [
            {
              agentLabel: 'reviewer',
              state: 'BUSY',
              availability: 'Reviewing',
              verifiedAt: '2026-09-10T12:00:00.000Z',
              lastActivityAt: new Date().toISOString(),
            },
            {
              agentLabel: 'quiet',
              state: 'AWAY',
              availability: null,
              verifiedAt: '2026-09-09T12:00:00.000Z',
              lastActivityAt: '2026-09-09T12:00:00.000Z',
            },
          ],
        });
      }
      return response({
        summaries: [
          {
            agentLabel: 'reviewer',
            text: 'Reviewing a change.',
            generatedAt: '2026-09-10T12:00:00.000Z',
            evidence: ['handoff:h1', 'conversation-message:m1'],
          },
          {
            agentLabel: 'quiet',
            text: 'No current work.',
            generatedAt: '2026-09-10T12:00:00.000Z',
            evidence: [],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AgentDirectoryCard />);
    expect(await screen.findByText('Reviewing a change.')).toBeVisible();
    expect(screen.getByText('BUSY', { exact: true })).toBeVisible();
    expect(screen.getByText(/handoff:h1, conversation-message:m1/)).toBeVisible();
    expect(screen.getByText('Live presence: Unknown')).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Filter activity/), { target: { value: 'quiet' } });
    expect(screen.queryByText('Review Agent')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check presence' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
  });

  it('fails closed to unknown for malformed activity timestamps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/agents/directory')) {
          return response({
            agents: [
              {
                id: 'a1',
                label: 'broken',
                displayName: 'Broken Agent',
                trustLevel: 'VERIFIED',
                availability: 'CURRENT',
                capabilities: [],
              },
            ],
          });
        }
        if (url.includes('/agents/presence')) {
          return response({
            presence: [
              {
                agentLabel: 'broken',
                state: 'AVAILABLE',
                availability: null,
                verifiedAt: 'not-a-date',
                lastActivityAt: 'not-a-date',
              },
            ],
          });
        }
        return response({ summaries: [] });
      }),
    );
    render(<AgentDirectoryCard />);
    expect(await screen.findByText('Live presence: Unknown')).toBeVisible();
  });
});

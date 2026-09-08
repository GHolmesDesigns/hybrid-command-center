import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from './App.test-setup';
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
});

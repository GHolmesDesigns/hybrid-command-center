import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from './App.test-setup';
import { AgentMemoryReviewCard } from './components/AgentMemoryReviewCard';

describe('Agent memory review card', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads the suggested queue and shows its empty state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ memories: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(<AgentMemoryReviewCard flash={vi.fn()} />);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Memory review queue' }),
    ).toBeVisible();
    await waitFor(() => expect(screen.getByText('No memories match this filter.')).toBeVisible());
  });
});

import {
  render,
  screen,
  waitFor,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from './App.test-setup';
import { WaitingInboxCard } from './components/WaitingInboxCard';

describe('Waiting on you inbox', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows sorted rows, deep links, and compact limits', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: '1',
              kind: 'HANDOFF',
              agent: 'a',
              waitingSince: '2026-01-01',
              destination: 'Stale handoff',
              resolutionPath: '/agents#agent-handoffs',
              detail: 'Review',
            },
            {
              id: '2',
              kind: 'AGENT_ACTIVITY',
              agent: 'b',
              waitingSince: '2026-01-02',
              destination: 'Suggested memory',
              resolutionPath: '/agents#agent-memory',
              detail: 'Key: value',
            },
          ],
          warnings: ['One source is unavailable.'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    render(
      <MemoryRouter>
        <WaitingInboxCard compact />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Stale handoff')).toBeInTheDocument());
    expect(screen.getByText('Suggested memory')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('One source is unavailable.');
    expect(screen.getAllByRole('link', { name: 'Review' })).toHaveLength(2);
  });

  it('shows an explicit empty state when the source has no rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], warnings: [] }), { status: 200 }),
    );
    render(
      <MemoryRouter>
        <WaitingInboxCard />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument();
  });
});

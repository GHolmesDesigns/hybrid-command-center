import { AgentCostSnapshotsCard } from './components/AgentCostSnapshotsCard';
import { AGENT_COST_PROVIDER_REPORTED } from '../../shared/agent-cost';
import {
  describe,
  expect,
  it,
  render,
  screen,
  waitFor,
  fireEvent,
  requests,
  testState,
} from './App.test-setup';

const snapshot = {
  id: 'cost-1',
  provider: 'cursor',
  model: 'gpt-4.1',
  quantity: 12_500,
  unit: 'tokens' as const,
  currency: 'USD',
  windowStart: '2026-09-01T00:00:00.000Z',
  windowEnd: '2026-09-11T23:59:59.999Z',
  attributionConfidence: 'exact',
  agentLabel: 'queue-agent',
  snapshotAt: '2026-09-11T12:00:00.000Z',
  refreshId: 'refresh-1',
};

describe('agent cost snapshots card', () => {
  it('shows provider-reported usage with provenance and refreshes on request', async () => {
    testState.agentCostPayload = {
      available: true,
      lastRefreshAt: snapshot.snapshotAt,
      snapshots: [snapshot],
    };
    const flashes: string[] = [];
    render(<AgentCostSnapshotsCard flash={(message) => flashes.push(message)} />);
    expect(await screen.findByText('queue-agent')).toBeVisible();
    expect(screen.getByText(AGENT_COST_PROVIDER_REPORTED)).toBeVisible();
    expect(screen.getByText(/Provider attribution: Exact/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await waitFor(() =>
      expect(requests.some((entry) => entry.url.endsWith('/api/agents/cost/refresh'))).toBe(true),
    );
  });

  it('names unavailable configuration and empty storage honestly', async () => {
    testState.agentCostPayload = { available: false, snapshots: [] };
    render(<AgentCostSnapshotsCard flash={() => undefined} />);
    expect(await screen.findByText(/CURSOR_ADMIN_API_KEY/)).toBeVisible();
    testState.agentCostPayload = { available: true, snapshots: [] };
    render(<AgentCostSnapshotsCard flash={() => undefined} />);
    expect(await screen.findByText(/No provider-reported usage is stored yet/)).toBeVisible();
  });
});

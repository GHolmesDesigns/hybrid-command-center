import { describe, expect, it, vi, render, screen, waitFor, fireEvent } from './App.test-setup';
import { HealthView } from './components/HealthView';

const response = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

const sample = {
  generatedAt: '2026-09-08T12:00:00.000Z',
  overall: 'healthy',
  signals: {
    process: {
      state: 'healthy',
      label: 'Process',
      detail: 'Running normally.',
      checkedAt: '2026-09-08T12:00:00.000Z',
      freshness: 'just now',
    },
    database: {
      state: 'degraded',
      label: 'Database',
      detail: 'Slow queries observed.',
      checkedAt: '2026-09-08T11:55:00.000Z',
      freshness: '5 minutes ago',
    },
    agentActivity: {
      state: 'healthy',
      label: 'Agent activity',
      detail: 'Agents are checking in.',
      checkedAt: '2026-09-08T12:00:00.000Z',
      freshness: 'just now',
    },
    remoteAgents: {
      state: 'unavailable',
      label: 'Remote agents',
      detail: 'No remote agents reachable.',
      checkedAt: null,
      freshness: 'never',
    },
  },
};

describe('HealthView', () => {
  it('shows overall status and one card per signal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response(sample)),
    );

    render(<HealthView />);

    expect(await screen.findByRole('status')).toHaveTextContent('Overall status: healthy');
    expect(screen.getByRole('heading', { name: 'Process' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Database' })).toBeVisible();
    expect(screen.getByText('Slow queries observed.')).toBeVisible();
    expect(screen.getByText('No remote agents reachable.')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a failed health check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response({ error: 'Health dashboard unavailable.' }, false)),
    );

    render(<HealthView />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Health check failed: Health dashboard unavailable.',
    );
  });

  it('re-checks health on demand', async () => {
    const fetchMock = vi.fn(() => response(sample));
    vi.stubGlobal('fetch', fetchMock);

    render(<HealthView />);
    await screen.findByRole('status');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Re-check health/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

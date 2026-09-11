import {
  render,
  screen,
  waitFor,
  fireEvent,
  describe,
  expect,
  it,
  requests,
  testState,
} from './App.test-setup';
import { PublishConfirmationRequestsCard } from './components/PublishConfirmationRequestsCard';

describe('agent publish confirmation requests', () => {
  it('shows the exact agent request and only publishes after operator approval', async () => {
    testState.publishConfirmationRequestsPayload = [
      {
        id: 'publish-request-1',
        agentLabel: 'content-agent',
        confirmation: 'Publish "Launch" at 2026-09-15T14:00:00.000Z to LinkedIn.',
        status: 'PENDING',
        createdAt: '2026-09-11T12:00:00.000Z',
        error: null,
      },
    ];
    testState.publishConfirmationQueueSummary = {
      ...testState.publishConfirmationQueueSummary,
      pendingCount: 1,
      oldestPendingAt: '2026-09-11T12:00:00.000Z',
      oldestPendingAgeMs: 90 * 60 * 1000,
    };

    render(<PublishConfirmationRequestsCard flash={() => undefined} />);

    expect(await screen.findByRole('heading', { name: 'Publish confirmations' })).toBeVisible();
    expect(screen.getByText(/Publish "Launch"/)).toBeVisible();
    expect(screen.getByText(/Requested by content-agent/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(screen.getByText('No pending publish confirmations.')).toBeVisible(),
    );
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/signal/publish-confirmations/publish-request-1/approve'),
      ),
    ).toBe(true);
  });

  it('does not offer a provider action for expired or uncertain requests', async () => {
    testState.publishConfirmationRequestsPayload = [
      {
        id: 'expired-publish',
        agentLabel: 'content-agent',
        confirmation: 'Publish "Old" now to LinkedIn.',
        status: 'EXPIRED',
        createdAt: '2026-09-01T12:00:00.000Z',
        error: 'Publish confirmation expired before operator action.',
      },
      {
        id: 'uncertain-publish',
        agentLabel: 'content-agent',
        confirmation: 'Publish "Maybe" now to LinkedIn.',
        status: 'PROVIDER_UNCERTAIN',
        createdAt: '2026-09-01T13:00:00.000Z',
        error: 'Provider outcome is uncertain.',
      },
    ];

    render(<PublishConfirmationRequestsCard flash={() => undefined} />);

    expect(await screen.findByText(/Expired without operator action/)).toBeVisible();
    expect(screen.getByText(/Provider outcome is uncertain/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });
});

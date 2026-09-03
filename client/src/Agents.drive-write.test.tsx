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
import { DriveWriteRequestsCard } from './components/DriveWriteRequestsCard';

describe('agent Drive write requests', () => {
  it('shows the exact pending action and executes only the operator decision', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };
    testState.driveWriteRequestsPayload = [
      {
        id: 'request-1',
        agentLabel: 'content-agent',
        confirmation: 'Upload "brief.pdf" (42 bytes) to "01_Admin".',
        status: 'PENDING',
        createdAt: '2026-09-02T12:00:00.000Z',
        error: null,
      },
    ];
    testState.driveWriteQueueSummary = {
      ...testState.driveWriteQueueSummary,
      pendingCount: 1,
      pendingDecodedBytes: 42,
      oldestPendingAt: '2026-09-02T12:00:00.000Z',
      oldestPendingAgeMs: 90 * 60 * 1000,
    };

    render(<DriveWriteRequestsCard flash={() => undefined} />);

    expect(await screen.findByRole('heading', { name: 'Drive write requests' })).toBeVisible();
    expect(screen.getByText('Upload "brief.pdf" (42 bytes) to "01_Admin".')).toBeVisible();
    expect(screen.getByText(/Requested by content-agent/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('No pending Drive write requests.')).toBeVisible());
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/drive-write-requests/request-1/approve'),
      ),
    ).toBe(true);
  });

  it('explains expired and uncertain requests without offering decisions', async () => {
    testState.driveWriteRequestsPayload = [
      {
        id: 'expired-request',
        agentLabel: 'content-agent',
        confirmation: 'Create folder "Old assets".',
        status: 'EXPIRED',
        createdAt: '2026-09-01T12:00:00.000Z',
        error: 'Pending Drive write request expired.',
      },
      {
        id: 'uncertain-request',
        agentLabel: 'content-agent',
        confirmation: 'Upload "clip.mp4".',
        status: 'PROVIDER_UNCERTAIN',
        createdAt: '2026-09-01T13:00:00.000Z',
        error: 'Execution lease expired; provider outcome is uncertain.',
      },
    ];
    testState.driveWriteQueueSummary = {
      ...testState.driveWriteQueueSummary,
      expiredCount: 1,
      providerUncertainCount: 1,
    };

    render(<DriveWriteRequestsCard flash={() => undefined} />);

    expect(await screen.findByText(/Expired without operator action/)).toBeVisible();
    expect(screen.getByText(/Provider outcome is uncertain/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('keeps the default empty state when no agent request exists', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };
    render(<DriveWriteRequestsCard flash={() => undefined} />);
    expect(await screen.findByText('No pending Drive write requests.')).toBeVisible();
  });
});

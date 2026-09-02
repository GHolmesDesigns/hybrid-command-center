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

  it('keeps the default empty state when no agent request exists', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };
    render(<DriveWriteRequestsCard flash={() => undefined} />);
    expect(await screen.findByText('No pending Drive write requests.')).toBeVisible();
  });
});

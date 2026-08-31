import {
  render,
  screen,
  waitFor,
  fireEvent,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
  App,
  requests,
  testState,
} from './App.test-setup';

describe('Agents connection setup card', () => {
  afterEach(() => vi.restoreAllMocks());

  it('labels workspace scopes accurately and keeps coordination-only defaults', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Agent connection setup' })).toBeVisible();
    expect(screen.getByLabelText('Read workspace and Signal data')).not.toBeChecked();
    expect(screen.getByLabelText('Write workspace and Signal data')).not.toBeChecked();
    expect(screen.getByLabelText('Read coordination')).toBeChecked();
    expect(screen.getByLabelText('Write coordination')).toBeChecked();
    expect(screen.queryByText(/reserved/i)).not.toBeInTheDocument();
  });

  it('issues a credential, shows client guide steps, runs the diagnostic, and revokes', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };
    testState.mcpHealthTestPayload = {
      ok: true,
      status: {
        ok: true,
        transport: 'operator',
        authenticated: true,
        protocolVersion: '2024-11-05',
        agentLabel: null,
        grantedScopes: ['coordination:read', 'coordination:write'],
        storeId: 'store-fixture-1',
        baseUrl: 'https://hcc.example.com',
        serverVersion: '5.7.1',
        capabilityVersion: '5.7.1',
        serverClock: '2026-08-28T12:00:00.000Z',
        checks: {
          toolsList: { ok: true, toolCount: 12 },
          resourcesList: { ok: true, resourceCount: 2 },
          resourceRead: { ok: true, uri: 'hcc://workspace/context', byteLength: 100 },
        },
        testedAt: '2026-08-28T12:00:00.000Z',
      },
      workspaceChecksumUnchanged: true,
      lastUsedAt: '2026-08-28T12:00:00.000Z',
      credential: {
        id: 'credential-issued',
        issuedAt: '2026-08-28T11:00:00.000Z',
        expiresAt: '2026-11-26T10:00:00.000Z',
      },
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Agent connection setup' })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Agent label'), {
      target: { value: 'cursor-planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    expect(await screen.findByText(/Open Cursor Settings/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Copy ready-to-paste setup for Cursor' }),
    ).toBeVisible();
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/auth/mcp-agents') &&
          request.body.label === 'cursor-planning',
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Copy ready-to-paste setup for Cursor' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]?.[0])).toContain('Bearer hcc_mcp_shown-once');
    expect(String(writeText.mock.calls[0]?.[0])).not.toContain('x-agent-label');

    fireEvent.click(screen.getByRole('button', { name: 'Check server health for this setup' }));
    expect(await screen.findByText('Server health passed')).toBeVisible();
    expect(screen.getByText('Diagnostic credential: credential-issued')).toBeVisible();
    expect(screen.getByText(/Issued:/)).toBeVisible();
    expect(screen.getAllByText(/Expires:/)).toHaveLength(2);
    expect(screen.getByText('Store ID: store-fixture-1')).toBeVisible();
    expect(screen.getByText('Base URL: https://hcc.example.com')).toBeVisible();
    expect(
      requests.some(
        (request) => request.method === 'POST' && request.url.endsWith('/api/mcp/health/test'),
      ),
    ).toBe(true);
    expect(
      requests.find(
        (request) => request.method === 'POST' && request.url.endsWith('/api/mcp/health/test'),
      )?.body,
    ).toEqual({ credentialId: 'credential-issued' });

    testState.mcpCredentialVerificationPayload = {
      credentialId: 'credential-issued',
      agentLabel: 'cursor-planning',
      storeId: 'store-fixture-verification',
      status: 'verified',
      verifiedAt: '2026-08-28T12:01:00.000Z',
    };
    fireEvent.click(screen.getByRole('button', { name: 'Check target-client verification' }));
    expect(await screen.findByText('Replacement credential verified')).toBeVisible();
    expect(screen.getByText('Credential ID: credential-issued')).toBeVisible();
    expect(screen.getByText('Store ID: store-fixture-verification')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke cursor-planning' }));
    await waitFor(() => expect(screen.queryByText('cursor-planning')).not.toBeInTheDocument());
    expect(screen.getByText('No active agent credentials.')).toBeVisible();
  });

  it('preserves a 90-day lifetime and scopes, confirms the exact expiry, and displays it after rotation', async () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    const expectedExpiry = '2026-11-30T12:00:00.000Z';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    testState.mcpAgentRegistryPayload = {
      enabled: true,
      credentials: [
        {
          id: 'cred-1',
          agentId: 'agent-1',
          label: 'cursor-planning',
          scopes: ['workspace:read'],
          issuedAt: '2026-08-28T10:00:00.000Z',
          expiresAt: '2026-11-26T10:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null,
          lastOrigin: null,
        },
      ],
    };
    const confirmation = vi.spyOn(window, 'confirm').mockImplementation((message) => {
      expect(message).toContain(`${expectedExpiry} (UTC)`);
      expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
      // Time spent considering the dialog must not change the confirmed expiry.
      clock.mockReturnValue(now + 60_000);
      return true;
    });

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Rotate cursor-planning' })).toBeVisible();
    expect(screen.getByLabelText('Expires after')).toHaveValue('30');
    confirmation.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate cursor-planning' }));
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(screen.getByText('2026-11-26T10:00:00.000Z (UTC)')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate cursor-planning' }));

    expect(await screen.findByText(/Open Cursor Settings/)).toBeVisible();
    expect(confirmation).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(`${expectedExpiry} (UTC)`)).toBeVisible();
    expect(screen.queryByText('2026-11-26T10:00:00.000Z (UTC)')).not.toBeInTheDocument();
    expect(
      requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/auth/mcp-credentials/cred-1/rotate'),
      ),
    ).toHaveLength(1);
    expect(
      requests.find((request) => request.url.endsWith('/api/auth/mcp-credentials/cred-1/rotate'))
        ?.body,
    ).toEqual({
      label: 'cursor-planning',
      scopes: ['workspace:read'],
      expiresAt: expectedExpiry,
    });
  });
});

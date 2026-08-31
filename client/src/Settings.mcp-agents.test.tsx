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
    expect(String(writeText.mock.calls[0]?.[0])).toContain('"x-agent-label": "cursor-planning"');

    fireEvent.click(screen.getByRole('button', { name: 'Run connection diagnostic' }));
    expect(await screen.findByText('Diagnostic passed')).toBeVisible();
    expect(screen.getByText('Store: store-fi')).toBeVisible();
    expect(
      requests.some(
        (request) => request.method === 'POST' && request.url.endsWith('/api/mcp/health/test'),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke cursor-planning' }));
    await waitFor(() => expect(screen.queryByText('cursor-planning')).not.toBeInTheDocument());
    expect(screen.getByText('No active agent credentials.')).toBeVisible();
  });

  it('rotates an existing credential and shows the new one-time setup', async () => {
    testState.mcpAgentRegistryPayload = {
      enabled: true,
      credentials: [
        {
          id: 'cred-1',
          agentId: 'agent-1',
          label: 'cursor-planning',
          scopes: ['coordination:read', 'coordination:write'],
          issuedAt: '2026-08-28T10:00:00.000Z',
          expiresAt: '2026-09-28T10:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null,
          lastOrigin: null,
        },
      ],
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Rotate cursor-planning' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate cursor-planning' }));

    expect(await screen.findByText(/Open Cursor Settings/)).toBeVisible();
    expect(
      requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/auth/mcp-credentials/cred-1/rotate'),
      ),
    ).toHaveLength(1);
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/auth/mcp-credentials/cred-1/rotate') &&
          request.body.label === 'cursor-planning',
      ),
    ).toBe(true);
  });
});

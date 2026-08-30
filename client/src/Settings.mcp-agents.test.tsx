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

describe('Settings Agent connection setup card', () => {
  afterEach(() => vi.restoreAllMocks());

  it('issues a credential, generates configuration, runs the diagnostic, and revokes', async () => {
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

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Agent connection setup' })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Agent label'), {
      target: { value: 'cursor-planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    expect(await screen.findByText(/Copy into \.cursor\/mcp\.json/)).toBeVisible();
    expect(screen.getByText(/"MCP_AGENT_LABEL": "cursor-planning"/)).toBeVisible();
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/auth/mcp-agents') &&
          request.body.label === 'cursor-planning',
      ),
    ).toBe(true);

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

  it('generates hosted HTTPS configuration with the issued bearer', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Agent connection setup' })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Agent label'), {
      target: { value: 'claude-review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    expect(await screen.findByText(/Copy into \.cursor\/mcp\.json/)).toBeVisible();

    fireEvent.change(screen.getByLabelText('Transport'), {
      target: { value: 'http' },
    });

    expect(await screen.findByText(/includes credential/)).toBeVisible();
    expect(screen.getByText(/Bearer hcc_mcp_shown-once/)).toBeVisible();
    expect(screen.getByText(/"x-agent-label": "claude-review"/)).toBeVisible();
  });
});

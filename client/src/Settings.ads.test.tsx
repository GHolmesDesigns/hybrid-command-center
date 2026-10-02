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
  fireEvent,
  within,
  App,
  requests,
  testState,
} from './App.test-setup';

const state = (overrides: Partial<NonNullable<typeof testState.adsStatusPayload>> = {}) => ({
  configured: true,
  missing: [],
  status: 'DISCONNECTED' as const,
  connectedAt: null,
  scope: null,
  viaManager: false,
  problem: null,
  ...overrides,
});

describe('Settings Google Ads connection (C256)', () => {
  afterEach(() => vi.restoreAllMocks());

  const renderSettings = async (path = '/settings') => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/api/ads/status'))).toBe(true),
    );
    return screen.findByRole('heading', { level: 2, name: 'Google Ads' });
  };

  it('offers Connect when disconnected and starts the Ads flow, not Drive’s', async () => {
    await renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Google Ads' }));
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/api/ads/oauth/start'))).toBe(true),
    );
    expect(requests.some((request) => request.url.endsWith('/api/drive/oauth/start'))).toBe(false);
    expect(screen.getByText('Ads offline')).toBeVisible();
  });

  it('names the missing variables and blocks Connect when Ads is not configured', async () => {
    testState.adsStatusPayload = state({
      configured: false,
      missing: ['GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_TOKEN_ENCRYPTION_KEY'],
    });
    await renderSettings();
    const card = await screen.findByRole('region', { name: 'Google Ads' });
    expect(await within(card).findByText('Credentials required')).toBeVisible();
    expect(within(card).getByText(/GOOGLE_ADS_CLIENT_SECRET/)).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Connect Google Ads' })).toBeDisabled();
  });

  it('shows the connected state and disconnects only after confirmation', async () => {
    testState.adsStatusPayload = state({
      status: 'CONNECTED',
      connectedAt: '2026-10-02T12:00:00.000Z',
      scope: 'https://www.googleapis.com/auth/adwords',
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await renderSettings();
    expect(await screen.findByText('Ads connected')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconnect Google Ads' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google Ads' }));
    expect(requests.some((request) => request.url.endsWith('/api/ads/disconnect'))).toBe(false);

    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google Ads' }));
    await waitFor(() =>
      expect(
        requests.some(
          (request) => request.url.endsWith('/api/ads/disconnect') && request.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Ads offline')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect Google Ads' })).toBeVisible();
  });

  it('shows why a connect was refused, offers Try again, and says nothing changed', async () => {
    await renderSettings('/settings?ads=error&reason=scope_mismatch');
    expect(await screen.findByText('Google Ads was not connected')).toBeVisible();
    expect(screen.getByText(/did not grant the Google Ads scope/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.getByText('Ads offline')).toBeVisible();
  });

  it('ignores an error reason it does not recognize rather than printing it', async () => {
    await renderSettings('/settings?ads=error&reason=<script>alert(1)</script>');
    expect(screen.queryByText('Google Ads was not connected')).toBeNull();
    expect(screen.queryByText(/script/)).toBeNull();
  });

  it('confirms a completed connect from the callback redirect', async () => {
    testState.adsStatusPayload = state({
      status: 'CONNECTED',
      connectedAt: '2026-10-02T12:00:00.000Z',
    });
    await renderSettings('/settings?ads=connected');
    expect(await screen.findByText('Google Ads connected')).toBeVisible();
    expect(screen.getByText(/approves no account/)).toBeVisible();
  });

  it('reports an unreadable saved credential as an issue and offers reconnect', async () => {
    testState.adsStatusPayload = state({
      status: 'ERROR',
      problem: 'The stored Google Ads credential cannot be read with the current encryption key.',
    });
    await renderSettings();
    expect(await screen.findByText('Saved connection is unusable')).toBeVisible();
    expect(screen.getByText('Ads issue')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconnect Google Ads' })).toBeVisible();
  });

  it('shows a status error with Retry that re-reads the status', async () => {
    testState.adsStatusError = 'Ads status is down.';
    await renderSettings();
    expect(await screen.findByText('Google Ads status unavailable')).toBeVisible();
    testState.adsStatusError = null;
    const before = requests.filter((request) => request.url.endsWith('/api/ads/status')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        requests.filter((request) => request.url.endsWith('/api/ads/status')).length,
      ).toBeGreaterThan(before),
    );
    await waitFor(() => expect(screen.queryByText('Google Ads status unavailable')).toBeNull());
  });
});

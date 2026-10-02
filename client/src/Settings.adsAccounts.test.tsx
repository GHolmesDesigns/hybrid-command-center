import {
  render,
  screen,
  waitFor,
  within,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
  fireEvent,
  App,
  client,
  requests,
  testState,
} from './App.test-setup';
import type { AdsAccountView } from '../../shared/ads';

const account = (customerId: string, overrides: Partial<AdsAccountView> = {}): AdsAccountView => ({
  customerId,
  discovered: true,
  approved: false,
  approvedAt: null,
  snapshot: null,
  stale: null,
  client: null,
  targetIssue: null,
  ...overrides,
});
const snapshot = (name: string, extra: Partial<NonNullable<AdsAccountView['snapshot']>> = {}) => ({
  descriptiveName: name,
  currencyCode: 'USD',
  timeZone: 'America/New_York',
  manager: false,
  status: 'ENABLED',
  snapshotAt: '2026-10-02T12:00:00.000Z',
  ...extra,
});

const acme = client('client-acme', 'Acme');
const beta = client('client-beta', 'Beta');

const renderSettings = async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
};

describe('Settings Ads accounts (C257)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders no accounts card while Ads is disconnected and nothing was ever listed', async () => {
    await renderSettings();
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/api/ads/accounts'))).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: 'Ads accounts' })).toBeNull();
  });

  it('renders no card for a bare list of IDs once Ads is disconnected', async () => {
    testState.adsAccountsPayload = {
      connectionStatus: 'DISCONNECTED',
      discoveredAt: '2026-10-02T12:00:00.000Z',
      accounts: [account('1234567890')],
    };
    await renderSettings();
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/api/ads/accounts'))).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: 'Ads accounts' })).toBeNull();
  });

  it('shows approved accounts under their client, the unassigned one explicitly, and refused ones without an Approve button path to a target', async () => {
    testState.clientsPayload = [acme, beta];
    testState.adsAccountsPayload = {
      connectionStatus: 'CONNECTED',
      discoveredAt: '2026-10-02T12:00:00.000Z',
      accounts: [
        account('1234567890', {
          approved: true,
          snapshot: snapshot('Agency account'),
          client: { id: acme.id, name: acme.name, status: 'ACTIVE' },
        }),
        account('4567890123', { approved: true, snapshot: snapshot('Second account') }),
        account('2345678901', {
          snapshot: snapshot('Agency manager', { manager: true }),
          targetIssue: 'MANAGER',
        }),
      ],
    };
    await renderSettings();
    const card = (await screen.findByRole('heading', { name: 'Ads accounts' })).closest('section')!;
    const acmeGroup = within(card).getByRole('group', { name: 'Acme accounts' });
    expect(within(acmeGroup).getByText('Agency account')).toBeVisible();
    const unassigned = within(card).getByRole('group', { name: 'Unassigned accounts' });
    expect(within(unassigned).getByText('Second account')).toBeVisible();
    expect(within(card).getByText(/Not a performance target: A manager account/)).toBeVisible();
  });

  it('marks an account stale with the reason while keeping its last snapshot', async () => {
    testState.clientsPayload = [acme];
    testState.adsAccountsPayload = {
      connectionStatus: 'DISCONNECTED',
      discoveredAt: '2026-10-02T12:00:00.000Z',
      accounts: [
        account('1234567890', {
          approved: true,
          snapshot: snapshot('Agency account'),
          stale: 'DISCONNECTED',
        }),
      ],
    };
    await renderSettings();
    expect(await screen.findByText('Agency account')).toBeVisible();
    expect(screen.getByText(/Stale: Google Ads is not connected/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'List accessible accounts' })).toBeDisabled();
  });

  it('approves one exact account only after confirmation', async () => {
    testState.adsAccountsPayload = {
      connectionStatus: 'CONNECTED',
      discoveredAt: '2026-10-02T12:00:00.000Z',
      accounts: [account('1234567890'), account('4567890123')],
    };
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await renderSettings();
    const button = await screen.findByRole('button', { name: 'Approve account 123-456-7890' });
    fireEvent.click(button);
    expect(confirmation).toHaveBeenCalledOnce();
    expect(requests.some((request) => request.url.includes('/approve'))).toBe(false);

    confirmation.mockReturnValueOnce(true);
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        requests.filter((request) => request.url.endsWith('/api/ads/accounts/1234567890/approve')),
      ).toHaveLength(1),
    );
    const sent = requests.find((request) => request.url.endsWith('/1234567890/approve'));
    expect(sent?.body).toEqual({ confirmCustomerId: '1234567890' });
    // Only the named account was approved; the other is still waiting.
    expect(
      requests.some((request) => request.url.endsWith('/api/ads/accounts/4567890123/approve')),
    ).toBe(false);
  });

  it('previews a mapping, writes nothing until confirmed, and sends the previewed hash', async () => {
    testState.clientsPayload = [acme, beta];
    testState.adsAccountsPayload = {
      connectionStatus: 'CONNECTED',
      discoveredAt: '2026-10-02T12:00:00.000Z',
      accounts: [account('1234567890', { approved: true, snapshot: snapshot('Agency account') })],
    };
    testState.adsMappingPreview = {
      customerId: '1234567890',
      accountName: 'Agency account',
      action: 'ASSIGN',
      from: null,
      to: { id: acme.id, name: 'Acme', status: 'ACTIVE' },
      planHash: 'a'.repeat(64),
    };
    await renderSettings();
    fireEvent.change(await screen.findByLabelText('Client for account 123-456-7890'), {
      target: { value: acme.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    const dialog = await screen.findByRole('group', { name: 'Confirm mapping' });
    expect(
      within(dialog).getByText(/Assign Agency account \(123-456-7890\) to Acme\./),
    ).toBeVisible();
    expect(requests.some((request) => request.url.endsWith('/mapping'))).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm mapping' }));
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/1234567890/mapping'))).toBe(true),
    );
    const sent = requests.find((request) => request.url.endsWith('/1234567890/mapping'));
    expect(sent?.body).toEqual({
      clientId: acme.id,
      planHash: 'a'.repeat(64),
    });
  });

  it('shows the server’s refusal of a stale preview and offers nothing to retry blindly', async () => {
    testState.clientsPayload = [acme];
    testState.adsAccountsPayload = {
      connectionStatus: 'CONNECTED',
      discoveredAt: '2026-10-02T12:00:00.000Z',
      accounts: [account('1234567890', { approved: true, snapshot: snapshot('Agency account') })],
    };
    testState.adsMappingPreview = {
      customerId: '1234567890',
      accountName: 'Agency account',
      action: 'ASSIGN',
      from: null,
      to: { id: acme.id, name: 'Acme', status: 'ACTIVE' },
      planHash: 'b'.repeat(64),
    };
    testState.adsMappingCommitError =
      'This account or client changed since the mapping was previewed.';
    await renderSettings();
    fireEvent.change(await screen.findByLabelText('Client for account 123-456-7890'), {
      target: { value: acme.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm mapping' }));
    expect(await screen.findByText(/changed since the mapping was previewed/)).toBeVisible();
  });
});

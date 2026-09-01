import {
  APP_VERSION,
  App,
  MemoryRouter,
  afterEach,
  describe,
  it,
  expect,
  render,
  screen,
  testState,
  vi,
} from './App.test-setup';

const renderSettings = async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'User manual' })).toBeVisible();
};

afterEach(() => vi.restoreAllMocks());

describe('the version-matched user manual', () => {
  it('builds a keyboard-reachable new-tab link from the reported version', async () => {
    await renderSettings();

    const link = await screen.findByRole('link', { name: /Open user manual/ });
    expect(link).toHaveAttribute('href', `/api/manual/${encodeURIComponent(APP_VERSION)}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('explains when the matching manual is unavailable', async () => {
    testState.manualPayload = { version: APP_VERSION, available: false, url: null };
    await renderSettings();

    expect(screen.queryByRole('link', { name: /Open user manual/ })).not.toBeInTheDocument();
    expect(
      await screen.findByText('The user manual for this version is not available yet.'),
    ).toBeVisible();
  });
});

import {
  render,
  screen,
  fireEvent,
  waitFor,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
  App,
  requests,
} from './App.test-setup';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
}

const renderSettings = async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await waitFor(() =>
    expect(requests.some((request) => request.url.endsWith('/api/settings/drive'))).toBe(true),
  );
};

const timerCard = () =>
  screen.getByRole('heading', { name: 'Timer notifications' }).closest('.settings-card')!;
const permissionStatus = () =>
  timerCard().querySelector('[aria-label="Notification permission status"]')!;

describe('timer notification settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockClear();
  });

  it('shows Allow notifications before the option checkboxes', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    await renderSettings();

    const card = timerCard();
    const button = screen.getByRole('button', { name: 'Allow notifications' });
    const master = screen.getByRole('checkbox', { name: 'Enable timer notifications' });
    expect(card.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(master) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('updates permission status from the request result', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
    await renderSettings();

    expect(permissionStatus()).toHaveTextContent('Permission: default.');
    fireEvent.click(screen.getByRole('button', { name: 'Allow notifications' }));
    await waitFor(() => expect(permissionStatus()).toHaveTextContent('Permission: granted.'));
  });

  it('refreshes permission status when the document regains visibility', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'default';
    await renderSettings();

    expect(permissionStatus()).toHaveTextContent('Permission: default.');
    FakeNotification.permission = 'denied';
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(permissionStatus()).toHaveTextContent('Permission: denied.'));
  });

  it('disables dependent options when timer notifications are off', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    window.localStorage.setItem(
      'hcc.task-timer-settings.v1',
      JSON.stringify({
        enabled: false,
        completion: true,
        unavailable: true,
        sound: true,
      }),
    );
    await renderSettings();

    expect(screen.getByRole('checkbox', { name: 'Session completion' })).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Permission unavailable warnings' }),
    ).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Sound when supported' })).toBeDisabled();
  });
});

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
  App,
  requests,
  testState,
} from './App.test-setup';
import { DRIVE_OAUTH_SCOPE } from '../../shared/drive-oauth.ts';
import * as drivePicker from './drivePicker';

describe('Settings Google Drive (C52)', () => {
  afterEach(() => vi.restoreAllMocks());

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

  it('opens Picker and saves the selected folder id', async () => {
    testState.driveSettingsPayload = {
      configured: true,
      pickerConfigured: true,
      connected: true,
      picker: {
        clientId: 'client',
        apiKey: 'key',
        appId: '1234567890',
        scope: DRIVE_OAUTH_SCOPE,
      },
    };
    const pick = vi.spyOn(drivePicker, 'pickDriveFolder').mockResolvedValue({
      id: 'folder-root-1',
      name: 'Command Center',
    });

    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Choose root folder with Google Picker/i }));

    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.url.endsWith('/api/settings/drive/root') &&
            request.method === 'POST' &&
            request.body?.folderId === 'folder-root-1',
        ),
      ).toBe(true),
    );
    expect(pick).toHaveBeenCalledOnce();
  });

  it('ignores a cancelled Picker without flashing an error', async () => {
    testState.driveSettingsPayload = {
      configured: true,
      pickerConfigured: true,
      connected: true,
      rootFolderId: 'existing',
      rootFolderUrl: 'https://drive.test/existing',
      picker: {
        clientId: 'client',
        apiKey: 'key',
        appId: '1234567890',
        scope: DRIVE_OAUTH_SCOPE,
      },
    };
    vi.spyOn(drivePicker, 'pickDriveFolder').mockRejectedValue(
      new drivePicker.DrivePickerCancelled(),
    );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Change root folder with Google Picker/i }));

    await waitFor(() => expect(drivePicker.pickDriveFolder).toHaveBeenCalled());
    expect(requests.some((request) => request.url.endsWith('/api/settings/drive/root'))).toBe(
      false,
    );
    expect(screen.queryByText(/failed|error/i)).toBeNull();
    confirmSpy.mockRestore();
  });

  it('shows reconnect guidance that names Google Account revocation', async () => {
    testState.driveSettingsPayload = {
      configured: true,
      pickerConfigured: true,
      connected: true,
      picker: {
        clientId: 'client',
        apiKey: 'key',
        appId: '1234567890',
        scope: DRIVE_OAUTH_SCOPE,
      },
    };
    await renderSettings();
    expect(screen.getByRole('link', { name: /Google Account permissions/i })).toHaveAttribute(
      'href',
      'https://myaccount.google.com/permissions',
    );
  });
});

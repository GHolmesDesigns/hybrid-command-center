/**
 * Unit coverage for Google Picker wiring. Scripts and Google globals are mocked — no real
 * Google APIs (`AGENTS.md`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIVE_OAUTH_SCOPE } from '../../shared/drive-oauth.ts';
import { DrivePickerCancelled, pickDriveFolder } from './drivePicker';

const GIS = 'https://accounts.google.com/gsi/client';
const GAPI = 'https://apis.google.com/js/api.js';

type Callback = (data: Record<string, unknown>) => void;

describe('pickDriveFolder', () => {
  let pickerCallback: Callback | undefined;
  let tokenCallback: ((response: { access_token?: string; error?: string }) => void) | undefined;
  let tokenErrorCallback: ((error: { type?: string; message?: string }) => void) | undefined;
  let setVisible: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pickerCallback = undefined;
    tokenCallback = undefined;
    tokenErrorCallback = undefined;
    setVisible = vi.fn();

    const chain = {
      setIncludeFolders: vi.fn().mockReturnThis(),
      setSelectFolderEnabled: vi.fn().mockReturnThis(),
      setMimeTypes: vi.fn().mockReturnThis(),
      addView: vi.fn().mockReturnThis(),
      setOAuthToken: vi.fn().mockReturnThis(),
      setDeveloperKey: vi.fn().mockReturnThis(),
      setAppId: vi.fn().mockReturnThis(),
      setCallback: vi.fn((cb: Callback) => {
        pickerCallback = cb;
        return chain;
      }),
      build: vi.fn(() => ({ setVisible })),
    };

    window.gapi = {
      load: (_name, options) => {
        options.callback();
      },
    };
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => {
            tokenCallback = config.callback;
            tokenErrorCallback = config.error_callback;
            return {
              requestAccessToken: () => {
                tokenCallback?.({ access_token: 'picker-access' });
              },
            };
          },
        },
      },
      picker: {
        PickerBuilder: function PickerBuilder(this: typeof chain) {
          return chain;
        } as unknown as new () => never,
        DocsView: function DocsView(this: typeof chain) {
          return chain;
        } as unknown as new (viewId: string) => never,
        ViewId: { FOLDERS: 'folders' },
        Action: { PICKED: 'picked', CANCEL: 'cancel' },
        Response: { ACTION: 'action', DOCUMENTS: 'docs' },
        Document: { ID: 'id', NAME: 'name', URL: 'url' },
      },
    };

    // Pretend both scripts are already loaded so loadScript resolves immediately.
    for (const src of [GIS, GAPI]) {
      const script = document.createElement('script');
      script.src = src;
      script.dataset.loaded = '1';
      document.head.appendChild(script);
    }
  });

  afterEach(() => {
    document.head.querySelectorAll('script').forEach((node) => node.remove());
    delete window.gapi;
    delete window.google;
    vi.restoreAllMocks();
  });

  const config = {
    clientId: 'client',
    apiKey: 'key',
    appId: '1234567890',
    scope: DRIVE_OAUTH_SCOPE,
  };

  it('resolves with the folder Google Picker returns', async () => {
    const pending = pickDriveFolder(config);
    await vi.waitFor(() => expect(pickerCallback).toBeDefined());
    pickerCallback!({
      action: 'picked',
      docs: [{ id: 'folder-1', name: 'Root', url: 'https://drive.test/folder-1' }],
    });
    await expect(pending).resolves.toEqual({
      id: 'folder-1',
      name: 'Root',
      url: 'https://drive.test/folder-1',
    });
    expect(setVisible).toHaveBeenCalledWith(true);
  });

  it('rejects with DrivePickerCancelled when the dialog is dismissed', async () => {
    const pending = pickDriveFolder(config);
    await vi.waitFor(() => expect(pickerCallback).toBeDefined());
    pickerCallback!({ action: 'cancel' });
    await expect(pending).rejects.toBeInstanceOf(DrivePickerCancelled);
  });

  it('rejects when Picker returns no folder id', async () => {
    const pending = pickDriveFolder(config);
    await vi.waitFor(() => expect(pickerCallback).toBeDefined());
    pickerCallback!({ action: 'picked', docs: [{}] });
    await expect(pending).rejects.toThrow(/no folder id/i);
  });

  it('rejects when Google Identity Services is missing', async () => {
    delete window.google!.accounts;
    await expect(pickDriveFolder(config)).rejects.toThrow(/Identity Services/i);
  });

  it('rejects when the token client returns an error', async () => {
    window.google!.accounts!.oauth2!.initTokenClient = (cfg) => {
      tokenCallback = cfg.callback;
      return {
        requestAccessToken: () => tokenCallback?.({ error: 'access_denied' }),
      };
    };
    await expect(pickDriveFolder(config)).rejects.toThrow(/access_denied/);
  });

  it('rejects when the token client error_callback fires', async () => {
    window.google!.accounts!.oauth2!.initTokenClient = (cfg) => {
      tokenErrorCallback = cfg.error_callback;
      return {
        requestAccessToken: () => tokenErrorCallback?.({ message: 'popup_closed' }),
      };
    };
    await expect(pickDriveFolder(config)).rejects.toThrow(/popup_closed/);
  });

  it('rejects when the Google API loader is unavailable', async () => {
    delete window.gapi;
    await expect(pickDriveFolder(config)).rejects.toThrow(/API loader/i);
  });

  it('rejects when Picker fails to load', async () => {
    window.gapi!.load = (_name, options) => {
      options.onerror?.();
    };
    await expect(pickDriveFolder(config)).rejects.toThrow(/Picker failed to load/i);
  });

  it('rejects when google.picker is missing after load', async () => {
    delete window.google!.picker;
    await expect(pickDriveFolder(config)).rejects.toThrow(/Picker is unavailable/i);
  });

  it('loads scripts that are not yet present', async () => {
    document.head.querySelectorAll('script').forEach((node) => node.remove());
    const appendSpy = vi.spyOn(document.head, 'appendChild');

    // Resolve script loads by firing load on each appended script.
    appendSpy.mockImplementation((node) => {
      const script = node as HTMLScriptElement;
      queueMicrotask(() => script.onload?.(new Event('load')));
      return node;
    });

    const pending = pickDriveFolder(config);
    await vi.waitFor(() => expect(pickerCallback).toBeDefined());
    pickerCallback!({
      action: 'picked',
      docs: [{ id: 'folder-2', name: 'Other' }],
    });
    await expect(pending).resolves.toMatchObject({ id: 'folder-2', name: 'Other' });
    expect(appendSpy).toHaveBeenCalled();
  });

  it('waits for an in-flight script that is already in the document', async () => {
    document.head.querySelectorAll('script').forEach((node) => node.remove());
    const gis = document.createElement('script');
    gis.src = GIS;
    document.head.appendChild(gis);
    const gapiScript = document.createElement('script');
    gapiScript.src = GAPI;
    document.head.appendChild(gapiScript);

    const pending = pickDriveFolder(config);
    queueMicrotask(() => {
      gis.dataset.loaded = '1';
      gis.dispatchEvent(new Event('load'));
      gapiScript.dataset.loaded = '1';
      gapiScript.dispatchEvent(new Event('load'));
    });
    await vi.waitFor(() => expect(pickerCallback).toBeDefined());
    pickerCallback!({ action: 'picked', docs: [{ id: 'folder-3', name: 'Waited' }] });
    await expect(pending).resolves.toMatchObject({ id: 'folder-3' });
  });

  it('rejects when an existing script fails to load', async () => {
    document.head.querySelectorAll('script').forEach((node) => node.remove());
    const gis = document.createElement('script');
    gis.src = GIS;
    document.head.appendChild(gis);

    const pending = pickDriveFolder(config);
    queueMicrotask(() => gis.dispatchEvent(new Event('error')));
    await expect(pending).rejects.toThrow(/Failed to load/);
  });

  it('uses the default drive.file scope when config omits one', async () => {
    let seenScope = '';
    window.google!.accounts!.oauth2!.initTokenClient = (cfg) => {
      seenScope = cfg.scope;
      tokenCallback = cfg.callback;
      return {
        requestAccessToken: () => tokenCallback?.({ access_token: 'tok' }),
      };
    };
    const pending = pickDriveFolder({
      clientId: 'c',
      apiKey: 'k',
      appId: '1',
    });
    await vi.waitFor(() => expect(pickerCallback).toBeDefined());
    pickerCallback!({ action: 'picked', docs: [{ id: 'f', name: 'n' }] });
    await pending;
    expect(seenScope).toBe(DRIVE_OAUTH_SCOPE);
  });
});

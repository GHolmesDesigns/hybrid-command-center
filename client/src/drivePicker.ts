/**
 * Google Picker for Command Center root-folder selection (C52).
 *
 * The browser never receives the server's stored refresh or access tokens. Picker uses a
 * short-lived access token from Google Identity Services with the same OAuth client id and
 * `drive.file` scope; selecting a folder attaches that folder to the app's grant so the
 * server-side refresh token can resolve it by id.
 */
import { DRIVE_OAUTH_SCOPE } from '../../shared/drive-oauth.ts';

export type DrivePickerConfig = {
  clientId: string;
  apiKey: string;
  appId: string;
  scope?: string;
};

export type DrivePickerFolder = { id: string; name: string; url?: string };

export class DrivePickerCancelled extends Error {
  constructor() {
    super('Folder selection cancelled.');
    this.name = 'DrivePickerCancelled';
  }
}

type GapiDocsView = {
  setIncludeFolders(v: boolean): GapiDocsView;
  setSelectFolderEnabled(v: boolean): GapiDocsView;
  setMimeTypes(types: string): GapiDocsView;
};

type GapiPickerBuilder = {
  addView(view: GapiDocsView): GapiPickerBuilder;
  setOAuthToken(token: string): GapiPickerBuilder;
  setDeveloperKey(key: string): GapiPickerBuilder;
  setAppId(appId: string): GapiPickerBuilder;
  setCallback(cb: (data: PickerResponse) => void): GapiPickerBuilder;
  build(): { setVisible(visible: boolean): void };
};

type GapiPicker = {
  PickerBuilder: new () => GapiPickerBuilder;
  DocsView: new (viewId: string) => GapiDocsView;
  ViewId: { FOLDERS: string };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string; URL: string };
};

type PickerResponse = Record<string, unknown>;

type TokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

declare global {
  interface Window {
    gapi?: {
      load: (name: string, options: { callback: () => void; onerror?: () => void }) => void;
    };
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => TokenClient;
        };
      };
      picker?: GapiPicker;
    };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) {
    if (existing.dataset.loaded === '1') return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
        once: true,
      });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function loadPickerApi(): Promise<GapiPicker> {
  await loadScript(GIS_SRC);
  await loadScript(GAPI_SRC);
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi?.load) {
      reject(new Error('Google API loader is unavailable.'));
      return;
    }
    window.gapi.load('picker', {
      callback: () => resolve(),
      onerror: () => reject(new Error('Google Picker failed to load.')),
    });
  });
  const picker = window.google?.picker;
  if (!picker) throw new Error('Google Picker is unavailable.');
  return picker;
}

function requestAccessToken(clientId: string, scope: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      reject(new Error('Google Identity Services is unavailable.'));
      return;
    }
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error || 'Google did not return an access token for Picker.'));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: (error) => {
        reject(new Error(error.message || error.type || 'Google sign-in for Picker failed.'));
      },
    });
    // Prefer a silent token when the operator already approved drive.file for this client.
    client.requestAccessToken({ prompt: '' });
  });
}

/**
 * Opens Google Picker in folder-selection mode and resolves with the chosen folder id.
 * Rejects with `DrivePickerCancelled` when the operator dismisses the dialog.
 */
export async function pickDriveFolder(config: DrivePickerConfig): Promise<DrivePickerFolder> {
  const scope = config.scope || DRIVE_OAUTH_SCOPE;
  const pickerApi = await loadPickerApi();
  const accessToken = await requestAccessToken(config.clientId, scope);

  return new Promise((resolve, reject) => {
    const view = new pickerApi.DocsView(pickerApi.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder');

    const picker = new pickerApi.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setCallback((data) => {
        const action = data[pickerApi.Response.ACTION];
        if (action === pickerApi.Action.CANCEL) {
          reject(new DrivePickerCancelled());
          return;
        }
        if (action !== pickerApi.Action.PICKED) return;
        const docs = data[pickerApi.Response.DOCUMENTS] as
          Array<Record<string, string>> | undefined;
        const doc = docs?.[0];
        const id = doc?.[pickerApi.Document.ID];
        if (!id) {
          reject(new Error('Google Picker returned no folder id.'));
          return;
        }
        resolve({
          id,
          name: doc?.[pickerApi.Document.NAME] || id,
          url: doc?.[pickerApi.Document.URL],
        });
      })
      .build();

    picker.setVisible(true);
  });
}

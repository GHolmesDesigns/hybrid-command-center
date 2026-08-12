/**
 * The read-only Drive listing, in the one shape the API answers with and the Files page
 * renders. Nothing here describes a write: this version browses a project's folder and
 * hands off to Drive itself for everything else (decision §5.8), so there is no upload,
 * download, move, rename, or delete anywhere in the vocabulary.
 */

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** One page's worth of items, as much of each as a list row needs and no more. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Where Drive itself shows this item — the only way to act on a file from this app. */
  url: string;
  /** Drive's own modified stamp, a UTC ISO string. Absent on items Drive does not date. */
  modifiedAt: string | null;
  /** Bytes, when Drive reports them. Folders and Google-native documents report none. */
  size: number | null;
}

/**
 * Why a listing looks the way it does. Every value is a state the user can act on, and
 * they are deliberately distinct: "no credentials on this machine" and "credentials but
 * no connection" need different next steps, and neither is the same as a Drive call that
 * failed while connected.
 */
export const DRIVE_LISTING_STATES = [
  'READY',
  'NOT_CONFIGURED',
  'NOT_CONNECTED',
  'NO_FOLDER',
  'FAILED',
] as const;
export type DriveListingState = (typeof DRIVE_LISTING_STATES)[number];

/** A folder this project may be browsed at, identified by ID rather than by name. */
export interface DriveScope {
  id: string;
  name: string;
  url: string | null;
}

export interface DriveListing {
  state: DriveListingState;
  projectId: string;
  projectName: string;
  /** The folder this page came from. Null unless the state is `READY`. */
  folder: DriveScope | null;
  /**
   * The folders this project can be browsed at: its Drive folder first, then the
   * subfolders provisioning recorded for it. A folder outside this list is reachable
   * only through Drive, which is what keeps one project's browser inside one project.
   */
  scopes: DriveScope[];
  files: DriveFile[];
  /** Drive's opaque cursor for the next page; null when this page is the last one. */
  nextPageToken: string | null;
  /** Drive's own words. Only ever set when the state is `FAILED`. */
  error: string | null;
}

/** How many items one page asks Drive for, and the cap the API accepts. */
export const DRIVE_PAGE_SIZE = 25;
export const DRIVE_PAGE_SIZE_MAX = 100;

export const isDriveFolder = (file: Pick<DriveFile, 'mimeType'>) =>
  file.mimeType === DRIVE_FOLDER_MIME;

const GOOGLE_KINDS: Record<string, string> = {
  [DRIVE_FOLDER_MIME]: 'Folder',
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.drawing': 'Google Drawing',
  'application/vnd.google-apps.shortcut': 'Shortcut',
  'application/pdf': 'PDF',
  'application/zip': 'Archive',
};

/**
 * A short, readable kind for a row. Paired with an icon rather than replacing one, so the
 * type of an item is never carried by colour or shape alone.
 */
export const driveFileKind = (mimeType: string) => {
  if (GOOGLE_KINDS[mimeType]) return GOOGLE_KINDS[mimeType];
  const [family] = mimeType.split('/');
  if (family === 'image') return 'Image';
  if (family === 'video') return 'Video';
  if (family === 'audio') return 'Audio';
  if (family === 'text') return 'Text';
  return 'File';
};

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A file's size for a list row. Google-native documents and folders report no size at
 * all, which is a fact about Drive rather than a zero-byte file, so they read as a dash.
 */
export const formatFileSize = (bytes: number | null) => {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
};

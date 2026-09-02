import type { Db } from '../db.ts';
import { driveClients } from './service.ts';
import {
  SIGNAL_DRIVE_MAX_BYTES,
  SIGNAL_DRIVE_IMAGE_MAX_BYTES,
  SIGNAL_DRIVE_MIME_TYPES,
  SIGNAL_DRIVE_VIDEO_MAX_DURATION_MS,
  SIGNAL_DRIVE_VIDEO_MIN_DURATION_MS,
  isSignalDriveMimeType,
  signalMediaFingerprint,
  signalPostMediaIssue,
  type SignalPostMedia,
} from '../../shared/signal-media.ts';
import { formatFileSize } from '../../shared/drive.ts';

/**
 * Binding one Signal media reference to one Drive file (C74).
 *
 * ## Why this is a module of its own
 *
 * `browse.ts` is the Files half: it lists a *project's* folders, by id, and refuses any other
 * folder. This is a different capability with a different scope — one file the user pasted a link
 * to, anywhere in the connected account — so it is a different module with a different provider
 * interface. `DriveProvider` has no method that reaches a file by id and does not gain one here,
 * which is what keeps Files exactly as narrow as `AGENTS.md` says it is: a mistake in the Files UI
 * still cannot reach this path, because the vocabulary it is handed does not contain it.
 *
 * ## What it does and does not do
 *
 * It **resolves metadata**. It reads no bytes, writes nothing to Drive, and makes the file no more
 * public than it already was. C75 is the card that streams bytes, and it will re-resolve this
 * fingerprint immediately before it does.
 *
 * A file id is never accepted from the browser. Every entry point takes a **link**, which is
 * parsed as a URL, checked against the two Drive hosts, and matched against the documented link
 * forms below; only the id that falls out of that is looked up. A raw id typed into a request body
 * is not a link and has nowhere to go.
 */

/** A link this app will not resolve, or a file it will not bind to. Answered as a 400. */
export class DriveMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveMediaError';
  }
}

/**
 * One Drive file as the metadata capability reads it — Drive's own field names, so the fields the
 * fingerprint is built from can be traced back to the API that reported them.
 */
export interface DriveMediaFile {
  id: string;
  name: string | null;
  mimeType: string | null;
  /** Decimal string from Drive, absent for folders and Google-native documents. */
  size: string | null;
  webViewLink: string | null;
  modifiedTime: string | null;
  /** Drive's monotonically increasing revision counter, as a decimal string. */
  version: string | null;
  md5Checksum: string | null;
  sha256Checksum: string | null;
  trashed: boolean;
  /** Set only on `application/vnd.google-apps.shortcut`. */
  shortcutTargetId: string | null;
  /** Reliable Drive video metadata, absent for non-video files or where Drive cannot inspect it. */
  videoDurationMillis: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
}

export interface DriveMediaStream {
  body: AsyncIterable<Uint8Array>;
}

/**
 * The one method this capability has.
 *
 * Deliberately not on `DriveProvider`: see the module note. There is no counterpart that reads
 * content, uploads, renames, or deletes, so nothing reachable from here can change Drive.
 */
export interface DriveMediaProvider {
  readonly connected: boolean;
  /** Canonical metadata for one file id, or a thrown error carrying Drive's own words. */
  getFile(fileId: string): Promise<DriveMediaFile>;
  /** Opens bytes for the already revalidated id. This method is never exposed through Files. */
  openFile(fileId: string, signal?: AbortSignal): Promise<DriveMediaStream>;
}

export class DisconnectedDriveMediaProvider implements DriveMediaProvider {
  readonly connected = false;
  async getFile(): Promise<DriveMediaFile> {
    throw new Error('Google Drive is not connected.');
  }
  async openFile(): Promise<DriveMediaStream> {
    throw new Error('Google Drive is not connected.');
  }
}

/** The metadata capability for this workspace, disconnected until Drive is. */
export const driveMediaProvider = (db: Db): DriveMediaProvider =>
  driveClients(db)?.media ?? new DisconnectedDriveMediaProvider();

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
/** Drive ids are opaque; this is the character set and the length band they have always used. */
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
/** The `docs.google.com` paths that are a Google-native document rather than a stored file. */
const NATIVE_DOC_PATHS = new Set(['document', 'spreadsheets', 'presentation', 'forms', 'drawings']);

/**
 * The id, or a refusal — and deliberately not an echo of what was pasted. Reflecting arbitrary
 * input into a message adds nothing a person needs and puts a stranger's string on the page.
 */
const idOrThrow = (value: string | null | undefined): string => {
  const id = (value ?? '').trim();
  if (!FILE_ID.test(id))
    throw new DriveMediaError(
      'That link carries no Drive file id this app recognises. Copy the link from Drive itself, under Share.',
    );
  return id;
};

/**
 * The file id a documented Drive link addresses.
 *
 * URL parsing and host validation come first and there is no fallback that scrapes an id out of
 * arbitrary text: a string that is not a Drive link is refused rather than mined for something
 * that looks like one. Every refusal names what is wrong, because "invalid link" is a message
 * nobody can act on.
 *
 * The forms accepted are the ones Drive itself produces:
 * `…/file/d/<id>/view`, `…/open?id=<id>`, and `…/uc?id=<id>` on either host.
 */
export function parseDriveMediaLink(link: string): string {
  const trimmed = (link ?? '').trim();
  if (!trimmed) throw new DriveMediaError('Paste a Google Drive file link.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DriveMediaError(
      'That is not a link. Paste the whole Drive share link, starting with https://.',
    );
  }
  if (url.protocol !== 'https:') throw new DriveMediaError('A Drive link must use https.');
  if (!DRIVE_HOSTS.has(url.hostname))
    throw new DriveMediaError(
      `${url.hostname} is not Google Drive. Paste a link from drive.google.com.`,
    );

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'drive' && segments[1] === 'folders')
    throw new DriveMediaError(
      'That is a Drive folder, and a post carries one file at a time. Open the folder and copy the link of the file you want.',
    );
  if (segments[0] === 'drive' && segments[1] === 'my-drive')
    throw new DriveMediaError('That is a Drive view rather than a file. Copy a file link.');
  if (segments[0] && NATIVE_DOC_PATHS.has(segments[0]))
    throw new DriveMediaError(
      'That is a Google Docs, Sheets, or Slides document, which has no downloadable bytes to publish. Export it to PDF, put the export in Drive, and paste that link.',
    );
  if (segments[0] === 'file' && segments[1] === 'd') return idOrThrow(segments[2]);
  if (segments[0] === 'open' || segments[0] === 'uc') return idOrThrow(url.searchParams.get('id'));
  // `?id=` on any other Drive path is still an unambiguous file address, and refusing it would
  // refuse links Drive itself hands out. Anything with no id at all is not a file link.
  const query = url.searchParams.get('id');
  if (query) return idOrThrow(query);
  throw new DriveMediaError(
    'That Drive link does not address a single file. Use the file link Drive offers under Share.',
  );
}

/** Drive's `size` is a decimal string; anything else is refused rather than coerced. */
function sizeOrThrow(file: DriveMediaFile, name: string): number {
  if (file.size === null || file.size === undefined || file.size.trim() === '')
    throw new DriveMediaError(
      `Drive reports no size for ${name}, so this app cannot check it against the publishing limit. That is usually a Google-native document or a folder.`,
    );
  const size = Number(file.size);
  if (!Number.isFinite(size) || !Number.isSafeInteger(size) || size <= 0)
    throw new DriveMediaError(`Drive reported an unusable size for ${name}: ${file.size}.`);
  if (size > SIGNAL_DRIVE_MAX_BYTES)
    throw new DriveMediaError(
      `${name} is ${formatFileSize(size)} and this app binds files up to ${formatFileSize(SIGNAL_DRIVE_MAX_BYTES)}. Use a smaller export.`,
    );
  return size;
}

/**
 * One Drive file, canonicalized into the stored descriptor, or a refusal that names the reason.
 *
 * The rule is the same one for a paste and for an explicit recheck — there is one of these and
 * both call it, which is what keeps a recheck from accepting a file the paste would have refused.
 *
 * A shortcut is followed exactly one hop. A shortcut whose target is itself a shortcut, or that
 * carries no target, is refused: "resolves to one file" has to be a fact rather than a hope, and
 * chasing a chain would make which file this reference means depend on when it was chased.
 */
export async function resolveDriveMedia(input: {
  link: string;
  provider: DriveMediaProvider;
  now?: () => string;
}): Promise<SignalPostMedia> {
  const fileId = parseDriveMediaLink(input.link);
  return resolveDriveMediaFile({ fileId, provider: input.provider, now: input.now });
}

/** Resolves an already project-scoped Drive file id for the folder-batch capability. */
export async function resolveDriveMediaFile(input: {
  fileId: string;
  provider: DriveMediaProvider;
  now?: () => string;
}): Promise<SignalPostMedia> {
  const now = input.now ?? (() => new Date().toISOString());
  if (!input.provider.connected)
    throw new DriveMediaError(
      'Google Drive is not connected, so a Drive file cannot be checked. Connect it in Settings.',
    );

  let file = await read(input.provider, input.fileId);
  if (file.mimeType === SHORTCUT_MIME) {
    if (!file.shortcutTargetId)
      throw new DriveMediaError(
        'That link is a Drive shortcut with no target, so it does not resolve to one file. Link the file itself.',
      );
    const target = await read(input.provider, file.shortcutTargetId);
    if (target.mimeType === SHORTCUT_MIME)
      throw new DriveMediaError(
        'That link is a shortcut to another shortcut, so it does not resolve to one file. Link the file itself.',
      );
    file = target;
  }

  return descriptorFromFile(file, now());
}

/** Canonical descriptor from Drive's current metadata. Shared by paste and submit revalidation. */
function descriptorFromFile(file: DriveMediaFile, verifiedAt: string): SignalPostMedia {
  const name = file.name?.trim() || 'that file';
  if (file.trashed)
    throw new DriveMediaError(`${name} is in the Drive trash. Restore it or link another file.`);
  const mimeType = file.mimeType?.trim() ?? '';
  if (!mimeType) throw new DriveMediaError(`Drive reports no type for ${name}.`);
  if (mimeType.startsWith(GOOGLE_NATIVE_PREFIX))
    throw new DriveMediaError(
      `${name} is a Google-native document with no downloadable bytes to publish. Export it to PDF, put the export in Drive, and link that.`,
    );
  if (!isSignalDriveMimeType(mimeType))
    throw new DriveMediaError(
      `${name} is ${mimeType}, and the publisher accepts ${SIGNAL_DRIVE_MIME_TYPES.join(', ')}. Convert it first.`,
    );
  const sizeBytes = sizeOrThrow(file, name);

  const media: SignalPostMedia = {
    source: 'DRIVE',
    // Drive's own canonical link, so the stored URL is the page a person opens and the string a
    // recheck parses back to this same id. The fallback is the form Drive would have given.
    url: file.webViewLink?.trim() || `https://drive.google.com/file/d/${file.id}/view`,
    driveFileId: file.id,
    driveName: file.name?.trim() || file.id,
    mimeType,
    sizeBytes,
    driveVersion: file.version?.trim() || null,
    driveModifiedAt: file.modifiedTime?.trim() || null,
    driveChecksum: file.sha256Checksum?.trim() || file.md5Checksum?.trim() || null,
    driveVerifiedAt: verifiedAt,
  };
  if (!media.driveVersion && !media.driveModifiedAt && !media.driveChecksum)
    throw new DriveMediaError(
      `Drive reported no version, modified time, or checksum for ${name}, so this app cannot tell later whether its content changed.`,
    );
  // The same rule the Zod boundary and the SQLite triggers state. Reaching it means one of the
  // checks above let something through, which is a bug here rather than a bad link.
  const issue = signalPostMediaIssue(media);
  if (issue) throw new DriveMediaError(issue);
  return media;
}

const SUPPORTED_VIDEO_RATIOS = [9 / 16, 16 / 9, 1, 4 / 3] as const;

/** Limits Drive itself exposes as reliable metadata; no byte sniffing or buffering is used. */
function validateCurrentLimits(file: DriveMediaFile, media: SignalPostMedia): void {
  const name = media.driveName ?? 'Drive file';
  const size = media.sizeBytes as number;
  if (media.mimeType?.startsWith('image/') && size > SIGNAL_DRIVE_IMAGE_MAX_BYTES)
    throw new DriveMediaError(
      `${name} is ${formatFileSize(size)}; Post Bridge accepts images up to ${formatFileSize(SIGNAL_DRIVE_IMAGE_MAX_BYTES)}.`,
    );
  if (!media.mimeType?.startsWith('video/')) return;
  const duration = Number(file.videoDurationMillis);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new DriveMediaError(
      `Drive reports no reliable video duration for ${name}, so the 3–300 second provider limit cannot be checked. Export the video again or use a public URL.`,
    );
  if (
    duration < SIGNAL_DRIVE_VIDEO_MIN_DURATION_MS ||
    duration > SIGNAL_DRIVE_VIDEO_MAX_DURATION_MS
  )
    throw new DriveMediaError(`${name} must be between 3 seconds and 5 minutes long.`);
  if (!file.videoWidth || !file.videoHeight)
    throw new DriveMediaError(
      `Drive reports no reliable dimensions for ${name}, so the provider aspect-ratio limit cannot be checked.`,
    );
  const ratio = file.videoWidth / file.videoHeight;
  if (!SUPPORTED_VIDEO_RATIOS.some((supported) => Math.abs(ratio - supported) < 0.01))
    throw new DriveMediaError(
      `${name} has an unsupported ${file.videoWidth}:${file.videoHeight} aspect ratio. Use 9:16, 16:9, 1:1, or 4:3.`,
    );
}

/**
 * Revalidates the complete C74 fingerprint before opening bytes, then exposes a counted stream.
 * A short body and a body that exceeds Drive's declaration are both failures; the latter aborts
 * the upstream request immediately.
 */
export async function openDriveMedia(input: {
  stored: SignalPostMedia;
  provider: DriveMediaProvider;
  signal?: AbortSignal;
}): Promise<{
  name: string;
  mimeType: string;
  sizeBytes: number;
  body: AsyncIterable<Uint8Array>;
}> {
  if (input.stored.source !== 'DRIVE' || !input.stored.driveFileId)
    throw new DriveMediaError('Only a version-bound Drive reference can be opened.');
  if (!input.provider.connected)
    throw new DriveMediaError('Google Drive is not connected. Connect it and recheck this file.');
  const currentFile = await read(input.provider, input.stored.driveFileId);
  const current = descriptorFromFile(
    currentFile,
    input.stored.driveVerifiedAt ?? new Date().toISOString(),
  );
  if (
    JSON.stringify(signalMediaFingerprint(current)) !==
    JSON.stringify(signalMediaFingerprint(input.stored))
  )
    throw new DriveMediaError(
      `${input.stored.driveName ?? 'The Drive file'} changed after the publishing preview. Recheck the Drive file and preview again.`,
    );
  validateCurrentLimits(currentFile, current);

  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  const opened = await input.provider.openFile(input.stored.driveFileId, signal);
  const expected = current.sizeBytes as number;
  const counted = async function* (): AsyncGenerator<Uint8Array> {
    let readBytes = 0;
    const iterator = opened.body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = next.value;
        readBytes += chunk.byteLength;
        if (readBytes > expected) {
          controller.abort();
          throw new DriveMediaError(
            `Drive sent more bytes for ${current.driveName ?? 'the file'} than the ${expected} bytes it declared.`,
          );
        }
        yield chunk;
      }
      if (readBytes !== expected)
        throw new DriveMediaError(
          `Drive ended ${current.driveName ?? 'the file'} after ${readBytes} of ${expected} bytes.`,
        );
    } finally {
      await iterator.return?.();
    }
  };
  return {
    name: current.driveName as string,
    mimeType: current.mimeType as string,
    sizeBytes: expected,
    body: counted(),
  };
}

/** Drive's own failure, kept as Drive's words and bounded so it cannot flood a response. */
async function read(provider: DriveMediaProvider, fileId: string): Promise<DriveMediaFile> {
  try {
    return await provider.getFile(fileId);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : 'Unknown Drive error';
    throw new DriveMediaError(`Drive could not return that file: ${detail}`);
  }
}

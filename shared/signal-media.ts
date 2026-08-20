import type { SignalMediaKind } from './signal.ts';

/**
 * What one media reference on a Signal post is, now that it can be two different things.
 *
 * Until C74 a reference was a public `https:` URL and nothing else, classified from its pathname.
 * That is still one of the two answers and is still the default. The other is a **Drive file**,
 * which a pathname cannot describe at all: a Drive share link addresses an HTML viewer page and
 * carries no extension, and — more to the point — a file id is not evidence of the bytes anybody
 * previewed, because Drive may replace a file's content under the same id.
 *
 * So a Drive reference carries a **version fingerprint** beside its identity: Drive's own
 * `version`, its `modifiedTime`, and its checksum. Nothing here reads bytes and nothing here
 * contacts Drive; this module is the vocabulary and the one rule that says whether a descriptor is
 * well formed. Resolution lives in `server/drive/media.ts`, which is a capability boundary of its
 * own that the Files browser cannot reach.
 *
 * `url` is non-null for both kinds, which is what keeps every existing display and selection path
 * working: a URL row stores the public URL, and a Drive row stores Drive's canonical
 * `webViewLink`. **A Drive row's `url` is a page for a person to open, never provider-fetchable
 * media.** The confirmed publishing path is the only path that reads a Drive row's bytes, and it
 * does so from `driveFileId` only after revalidating the fingerprint below.
 */

export const SIGNAL_MEDIA_SOURCES = ['URL', 'DRIVE'] as const;
export type SignalMediaSource = (typeof SIGNAL_MEDIA_SOURCES)[number];

export interface SignalPostMedia {
  /** `URL` is a public reference; `DRIVE` is a version-bound file in the connected account. */
  source: SignalMediaSource;
  /** The public URL, or Drive's canonical `webViewLink`. Always present, always for display. */
  url: string;
  /** Drive's file id. Null on a URL row. */
  driveFileId: string | null;
  /** Drive's own name for the file, as it was when this reference was last resolved. */
  driveName: string | null;
  /** Drive's reported MIME type. This is what classifies a Drive row — never its pathname. */
  mimeType: string | null;
  /** Drive's reported size in bytes. A file Drive gives no size for is refused, not stored as 0. */
  sizeBytes: number | null;
  /** Drive's monotonic `version`. One of three version signals, of which at least one is required. */
  driveVersion: string | null;
  /** Drive's `modifiedTime`, a UTC ISO string. */
  driveModifiedAt: string | null;
  /** Drive's content checksum. Evidence about bytes, and never a credential for reaching them. */
  driveChecksum: string | null;
  /**
   * When this app last resolved the fields above, a UTC ISO string.
   *
   * A fact about the resolution rather than about the file, which is why it is not part of the
   * fingerprint below: rechecking a file nobody has touched must leave the fingerprint identical,
   * and so must leave an open publish preview valid.
   */
  driveVerifiedAt: string | null;
}

/**
 * The MIME types a Drive reference may carry.
 *
 * Post Bridge's `create-upload-url` declares a closed enum of five
 * (`docs/post-bridge-api-surface.md` §5), and the live C73 probe verified that an outside value is
 * refused. A file outside the five is therefore rejected before Drive content can be opened.
 */
export const SIGNAL_DRIVE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
] as const;
export type SignalDriveMimeType = (typeof SIGNAL_DRIVE_MIME_TYPES)[number];

export const isSignalDriveMimeType = (value: string): value is SignalDriveMimeType =>
  (SIGNAL_DRIVE_MIME_TYPES as readonly string[]).includes(value);

/**
 * The largest Drive file this app will bind a reference to.
 *
 * The live C73 probe measured a 500 MB upload-reservation ceiling. The narrower image ceiling,
 * total ceiling, item count, and video metadata bounds below come from current provider support
 * material and remain independently enforced before Drive content can be opened.
 */
export const SIGNAL_DRIVE_MAX_BYTES = 500 * 1024 * 1024;
/** Provider-wide bounds recorded by C73 from the live API and current support material. */
export const SIGNAL_DRIVE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const SIGNAL_DRIVE_TOTAL_MAX_BYTES = 500 * 1024 * 1024;
export const SIGNAL_DRIVE_IMAGE_MAX_ITEMS = 35;
export const SIGNAL_DRIVE_VIDEO_MIN_DURATION_MS = 3_000;
export const SIGNAL_DRIVE_VIDEO_MAX_DURATION_MS = 300_000;

/**
 * The kind of a Drive reference, from the MIME type Drive reported and this app stored.
 *
 * Separate from `signalMediaKind`, which reads a pathname, because the two answer from different
 * evidence: a stored MIME type is Drive's own statement about the file, and a Drive share link's
 * pathname says only that the thing on the other end is a viewer page.
 */
export function signalMediaKindForMime(mimeType: string | null): SignalMediaKind {
  if (!mimeType) return 'unknown';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  return 'unknown';
}

/** A public reference, in the descriptor shape. Every Drive field is null and stays null. */
export const urlPostMedia = (url: string): SignalPostMedia => ({
  source: 'URL',
  url,
  driveFileId: null,
  driveName: null,
  mimeType: null,
  sizeBytes: null,
  driveVersion: null,
  driveModifiedAt: null,
  driveChecksum: null,
  driveVerifiedAt: null,
});

const DRIVE_ONLY_FIELDS = [
  ['driveFileId', 'a Drive file id'],
  ['driveName', 'a Drive name'],
  ['mimeType', 'a MIME type'],
  ['sizeBytes', 'a size'],
  ['driveVersion', 'a Drive version'],
  ['driveModifiedAt', 'a Drive modified time'],
  ['driveChecksum', 'a Drive checksum'],
  ['driveVerifiedAt', 'a Drive verification time'],
] as const satisfies readonly (readonly [keyof SignalPostMedia, string])[];

/**
 * The one cross-field rule, in one place.
 *
 * The Zod boundary, the write service, and the SQLite triggers in `server/db.ts` all state this
 * same contract, deliberately — a rule enforced in one layer alone is a rule that a `curl`, a
 * migration, or a later caller walks around. Returns the reason a descriptor is not storable, or
 * null when it is.
 *
 * A `DRIVE` row must carry an id, a name, a MIME type, a positive size, and **at least one**
 * version signal. One rather than all three because Drive does not report a checksum for every
 * file, and refusing a video because Drive gave a `version` and a `modifiedTime` but no
 * `md5Checksum` would refuse a file this app can perfectly well bind to.
 */
export function signalPostMediaIssue(media: SignalPostMedia): string | null {
  if (!(SIGNAL_MEDIA_SOURCES as readonly string[]).includes(media.source))
    return `A media reference's source must be URL or DRIVE, not ${String(media.source)}.`;
  if (typeof media.url !== 'string' || media.url.trim() === '')
    return 'A media reference needs a URL.';
  if (media.source === 'URL') {
    for (const [field, description] of DRIVE_ONLY_FIELDS)
      if (media[field] !== null) return `A public media reference cannot carry ${description}.`;
    return null;
  }
  if (!media.driveFileId?.trim()) return 'A Drive media reference needs a Drive file id.';
  if (!media.driveName?.trim()) return 'A Drive media reference needs the Drive file name.';
  if (!media.mimeType?.trim()) return 'A Drive media reference needs the Drive MIME type.';
  if (media.sizeBytes === null || !Number.isSafeInteger(media.sizeBytes) || media.sizeBytes <= 0)
    return 'A Drive media reference needs a positive size in bytes.';
  if (!media.driveVersion && !media.driveModifiedAt && !media.driveChecksum)
    return 'A Drive media reference needs at least one version signal: a Drive version, a modified time, or a checksum.';
  return null;
}

/**
 * What the plan hash covers for one reference.
 *
 * The complete discriminated descriptor and its version fingerprint, not only the display URL — so
 * replacing a Drive file's content under the same id invalidates a preview taken before the
 * replacement, exactly as editing the caption does. `driveVerifiedAt` is deliberately absent: see
 * the field's own note.
 */
export const signalMediaFingerprint = (media: SignalPostMedia) => ({
  source: media.source,
  url: media.url,
  driveFileId: media.driveFileId,
  driveName: media.driveName,
  mimeType: media.mimeType,
  sizeBytes: media.sizeBytes,
  driveVersion: media.driveVersion,
  driveModifiedAt: media.driveModifiedAt,
  driveChecksum: media.driveChecksum,
});

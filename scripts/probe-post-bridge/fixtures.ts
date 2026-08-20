/**
 * What the probe is allowed to upload.
 *
 * Three committed files, described in `scripts/fixtures/README.md` and rebuilt from their recipe by
 * `fixtures.test.ts`, plus one optional video the owner supplies for the session. The bytes never
 * reach the report; their `sha256` does, so the evidence says which asset was uploaded without the
 * transcript carrying it — and a fixture that changed under the same name changes the hash in the
 * next matrix.
 *
 * The size ceilings are here rather than at the call site because a fixture that grew is the way
 * this script could quietly start moving something substantial across two boundaries.
 */
import { createHash } from 'node:crypto';
import { PROBE_MIME_TYPES, type ProbeMimeType } from './requests.ts';

/**
 * A committed fixture is a few hundred bytes and there is no reason for one to be larger. The
 * ceiling exists so replacing a fixture with something real fails here instead of on the wire.
 */
export const PROBE_COMMITTED_FIXTURE_MAX_BYTES = 64 * 1024;

/**
 * The owner-supplied video. Eight mebibytes is far below every published platform bound and still
 * enough for a few seconds of anything, which is all a contract probe needs.
 */
export const PROBE_VIDEO_MAX_BYTES = 8 * 1024 * 1024;

export type ProbeFixtureKey = 'image' | 'cover' | 'document' | 'video';

export interface ProbeFixture {
  key: ProbeFixtureKey;
  /** The `name` sent to `create-upload-url`, and never a customer's filename. */
  name: string;
  mimeType: ProbeMimeType;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
}

/** The fixture as the report holds it: everything except the bytes. */
export interface ProbeFixtureRecord {
  key: ProbeFixtureKey;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export const COMMITTED_FIXTURES: readonly {
  key: Exclude<ProbeFixtureKey, 'video'>;
  file: string;
  name: string;
  mimeType: ProbeMimeType;
}[] = [
  { key: 'image', file: 'probe-image.png', name: 'probe-image.png', mimeType: 'image/png' },
  { key: 'cover', file: 'probe-cover.png', name: 'probe-cover.png', mimeType: 'image/png' },
  {
    key: 'document',
    file: 'probe-document.pdf',
    name: 'probe-document.pdf',
    mimeType: 'application/pdf',
  },
];

/** The MIME type a `--video` path is taken as, from its extension and nothing else. */
const VIDEO_MIME_BY_EXTENSION: Record<string, ProbeMimeType> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

export function fixtureRecord(fixture: ProbeFixture): ProbeFixtureRecord {
  return {
    key: fixture.key,
    name: fixture.name,
    mimeType: fixture.mimeType,
    sizeBytes: fixture.sizeBytes,
    sha256: fixture.sha256,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Reads one file by its name inside `scripts/fixtures/`, or an absolute path for the video. */
export type FixtureReader = (path: string) => Uint8Array;

export interface LoadFixturesOptions {
  readFile: FixtureReader;
  /** The owner-supplied disposable video, absent unless `--video` was given. */
  videoPath?: string;
}

function checkSize(label: string, bytes: Uint8Array, ceiling: number): void {
  if (bytes.byteLength === 0) throw new Error(`${label} is empty.`);
  if (bytes.byteLength > ceiling)
    throw new Error(
      `${label} is ${bytes.byteLength} bytes, over the ${ceiling}-byte ceiling this probe will upload.`,
    );
}

/**
 * The fixtures for one run, hashed.
 *
 * A missing or oversized committed fixture throws: the probe cannot answer question 2 or 3 without
 * something to upload, and continuing with a substitute would put an unexamined file on somebody's
 * social account. A missing `--video` does not throw — it is an expected state, and the caller turns
 * it into **still unverified** for the two roles that need one.
 */
export function loadProbeFixtures(
  options: LoadFixturesOptions,
): Map<ProbeFixtureKey, ProbeFixture> {
  const loaded = new Map<ProbeFixtureKey, ProbeFixture>();
  for (const committed of COMMITTED_FIXTURES) {
    const bytes = options.readFile(committed.file);
    checkSize(`Fixture ${committed.file}`, bytes, PROBE_COMMITTED_FIXTURE_MAX_BYTES);
    loaded.set(committed.key, {
      key: committed.key,
      name: committed.name,
      mimeType: committed.mimeType,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      bytes,
    });
  }
  if (options.videoPath !== undefined) {
    const lower = options.videoPath.toLowerCase();
    const extension = Object.keys(VIDEO_MIME_BY_EXTENSION).find((suffix) => lower.endsWith(suffix));
    if (!extension)
      throw new Error(
        `--video must be one of ${Object.keys(VIDEO_MIME_BY_EXTENSION).join(', ')}; the provider accepts ${PROBE_MIME_TYPES.filter(
          (mime) => mime.startsWith('video/'),
        ).join(' and ')} and nothing else.`,
      );
    const bytes = options.readFile(options.videoPath);
    checkSize('The --video file', bytes, PROBE_VIDEO_MAX_BYTES);
    loaded.set('video', {
      key: 'video',
      // Deliberately not the operator's filename: a real filename is the one part of a disposable
      // file that can still name a client, a campaign, or a person.
      name: 'probe-video' + extension,
      mimeType: VIDEO_MIME_BY_EXTENSION[extension],
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      bytes,
    });
  }
  return loaded;
}

import { describe, expect, it } from 'vitest';
import {
  SIGNAL_DRIVE_MAX_BYTES,
  SIGNAL_DRIVE_MIME_TYPES,
  isSignalDriveMimeType,
  signalMediaFingerprint,
  signalMediaKindForMime,
  signalPostMediaIssue,
  urlPostMedia,
  type SignalPostMedia,
} from './signal-media.ts';
import {
  signalMediaKind,
  signalMediaKindFor,
  signalPublicPreviewEligible,
  signalUrlLooksSignedOrExpiring,
  SIGNAL_PUBLIC_PREVIEW_MAX_ITEMS,
} from './signal.ts';

/**
 * The media vocabulary on its own: what a descriptor may be, how each kind is classified, and what
 * the plan hash is taken over. No database and no Drive — the rule this file holds is the one every
 * layer restates, so it is worth exercising where nothing else can be blamed for the answer.
 */

const drive = (overrides: Partial<SignalPostMedia> = {}): SignalPostMedia => ({
  source: 'DRIVE',
  url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view',
  driveFileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  driveName: 'launch.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 4096,
  driveVersion: '7',
  driveModifiedAt: '2026-03-01T12:00:00.000Z',
  driveChecksum: 'a-checksum',
  driveVerifiedAt: '2026-08-20T09:00:00.000Z',
  ...overrides,
});

describe('classifying a reference', () => {
  it('reads a Drive reference from its stored MIME type', () => {
    expect(signalMediaKindForMime('application/pdf')).toBe('pdf');
    expect(signalMediaKindForMime('video/quicktime')).toBe('video');
    expect(signalMediaKindForMime('image/png')).toBe('image');
    expect(signalMediaKindForMime('application/zip')).toBe('unknown');
    expect(signalMediaKindForMime(null)).toBe('unknown');
  });

  /**
   * The reason the two rules are separate. A Drive share link is a viewer page with no extension,
   * so the pathname rule answers `unknown` for every Drive file — which is exactly what a preflight
   * must not be told about a video.
   */
  it('picks the rule from the source, not from the caller', () => {
    const video = drive();
    expect(signalMediaKind(video.url)).toBe('unknown');
    expect(signalMediaKindFor(video)).toBe('video');
    expect(signalMediaKindFor(urlPostMedia('https://cdn.example.com/a.mp4'))).toBe('video');
    expect(signalMediaKindFor(urlPostMedia('https://cdn.example.com/a'))).toBe('unknown');
  });
});

describe('public preview eligibility', () => {
  it('allows only clean public HTTPS images and videos', () => {
    expect(signalPublicPreviewEligible(urlPostMedia('https://cdn.example.com/a.jpg'))).toBe(true);
    expect(signalPublicPreviewEligible(urlPostMedia('https://cdn.example.com/a.mp4'))).toBe(true);
    expect(signalPublicPreviewEligible(urlPostMedia('http://cdn.example.com/a.jpg'))).toBe(false);
    expect(signalPublicPreviewEligible(urlPostMedia('https://cdn.example.com/a.pdf'))).toBe(false);
    expect(signalPublicPreviewEligible(urlPostMedia('https://cdn.example.com/a'))).toBe(false);
    expect(signalPublicPreviewEligible(drive())).toBe(false);
  });

  it('keeps signed or expiring addresses as text', () => {
    expect(signalUrlLooksSignedOrExpiring('https://cdn.example.com/a.jpg?token=1')).toBe(true);
    expect(signalUrlLooksSignedOrExpiring('https://cdn.example.com/a.jpg#frag')).toBe(true);
    expect(signalUrlLooksSignedOrExpiring('https://cdn.example.com/a.jpg')).toBe(false);
    expect(signalPublicPreviewEligible(urlPostMedia('https://cdn.example.com/a.jpg?token=1'))).toBe(
      false,
    );
    expect(signalPublicPreviewEligible(urlPostMedia('https://cdn.example.com/a.mp4#exp=1'))).toBe(
      false,
    );
  });

  it('refuses an unparseable address rather than guessing it is safe to load', () => {
    expect(signalUrlLooksSignedOrExpiring('not a url')).toBe(true);
    expect(signalPublicPreviewEligible(urlPostMedia('not a url.jpg'))).toBe(false);
  });

  it('bounds how many public items one preview panel may load', () => {
    expect(SIGNAL_PUBLIC_PREVIEW_MAX_ITEMS).toBe(8);
  });
});

describe('the cross-field rule', () => {
  it('accepts a public reference and a fully described Drive one', () => {
    expect(signalPostMediaIssue(urlPostMedia('https://cdn.example.com/a.jpg'))).toBeNull();
    expect(signalPostMediaIssue(drive())).toBeNull();
  });

  it('refuses a source it does not know, and a reference with no address', () => {
    expect(signalPostMediaIssue({ ...drive(), source: 'FTP' as never })).toMatch(
      /must be URL or DRIVE, not FTP/,
    );
    expect(signalPostMediaIssue({ ...urlPostMedia(''), url: '   ' })).toBe(
      'A media reference needs a URL.',
    );
    expect(signalPostMediaIssue({ ...urlPostMedia(''), url: null as never })).toBe(
      'A media reference needs a URL.',
    );
  });

  /**
   * Every Drive column, one at a time. A public reference wearing any of them is not a public
   * reference with a stray field — it is a row nobody can classify, which is the whole reason the
   * discriminant exists.
   */
  it.each([
    ['driveFileId', 'a Drive file id'],
    ['driveName', 'a Drive name'],
    ['mimeType', 'a MIME type'],
    ['driveVersion', 'a Drive version'],
    ['driveModifiedAt', 'a Drive modified time'],
    ['driveChecksum', 'a Drive checksum'],
    ['driveVerifiedAt', 'a Drive verification time'],
  ] as const)('refuses a public reference carrying %s', (field, description) => {
    const media = { ...urlPostMedia('https://cdn.example.com/a.jpg'), [field]: 'something' };
    expect(signalPostMediaIssue(media)).toBe(
      `A public media reference cannot carry ${description}.`,
    );
  });

  it('refuses a public reference carrying a size', () => {
    expect(
      signalPostMediaIssue({ ...urlPostMedia('https://cdn.example.com/a.jpg'), sizeBytes: 1 }),
    ).toBe('A public media reference cannot carry a size.');
  });

  it.each([
    [{ driveFileId: null }, /needs a Drive file id/],
    [{ driveFileId: '   ' }, /needs a Drive file id/],
    [{ driveName: null }, /needs the Drive file name/],
    [{ mimeType: '  ' }, /needs the Drive MIME type/],
    [{ sizeBytes: null }, /positive size in bytes/],
    [{ sizeBytes: 0 }, /positive size in bytes/],
    [{ sizeBytes: -1 }, /positive size in bytes/],
    [{ sizeBytes: 1.5 }, /positive size in bytes/],
    [{ sizeBytes: Number.POSITIVE_INFINITY }, /positive size in bytes/],
    [
      { driveVersion: null, driveModifiedAt: null, driveChecksum: null },
      /at least one version signal/,
    ],
  ] as const)('refuses a Drive reference missing %j', (overrides, reason) => {
    expect(signalPostMediaIssue(drive(overrides))).toMatch(reason);
  });

  it('takes any one version signal on its own', () => {
    expect(signalPostMediaIssue(drive({ driveModifiedAt: null, driveChecksum: null }))).toBeNull();
    expect(signalPostMediaIssue(drive({ driveVersion: null, driveChecksum: null }))).toBeNull();
    expect(signalPostMediaIssue(drive({ driveVersion: null, driveModifiedAt: null }))).toBeNull();
  });

  it('refuses a Drive host on a public reference and names the Drive input', () => {
    expect(
      signalPostMediaIssue(
        urlPostMedia(
          'https://drive.google.com/file/d/1OUDJgha1n6kkDezljf4U52b7rvDBiuAj/view?usp=drive_link',
        ),
      ),
    ).toBe('drive.google.com is not public media. Add it with Add a Drive file by link instead.');
    expect(
      signalPostMediaIssue(
        urlPostMedia('https://docs.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view'),
      ),
    ).toBe('docs.google.com is not public media. Add it with Add a Drive file by link instead.');
  });
});

describe('the fail-closed provider limits', () => {
  it('carries the five documented MIME types and nothing else', () => {
    expect([...SIGNAL_DRIVE_MIME_TYPES]).toEqual([
      'image/png',
      'image/jpeg',
      'video/mp4',
      'video/quicktime',
      'application/pdf',
    ]);
    expect(isSignalDriveMimeType('image/png')).toBe(true);
    expect(isSignalDriveMimeType('image/webp')).toBe(false);
    expect(SIGNAL_DRIVE_MAX_BYTES).toBeGreaterThan(0);
  });
});

describe('what the plan hash is taken over', () => {
  it('covers the whole descriptor and leaves the verification time out', () => {
    const media = drive();
    expect(signalMediaFingerprint(media)).toEqual({
      source: 'DRIVE',
      url: media.url,
      driveFileId: media.driveFileId,
      driveName: 'launch.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      driveVersion: '7',
      driveModifiedAt: '2026-03-01T12:00:00.000Z',
      driveChecksum: 'a-checksum',
    });
    // Checking a file nobody touched must leave a plan valid, so the time of the check is not in it.
    expect(signalMediaFingerprint(drive({ driveVerifiedAt: '2030-01-01T00:00:00.000Z' }))).toEqual(
      signalMediaFingerprint(media),
    );
    // Every other field is in it, so replacing bytes under one id does not go unnoticed.
    expect(signalMediaFingerprint(drive({ driveChecksum: 'moved' }))).not.toEqual(
      signalMediaFingerprint(media),
    );
  });
});

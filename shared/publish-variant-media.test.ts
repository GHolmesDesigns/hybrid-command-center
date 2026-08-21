import { describe, expect, it } from 'vitest';
import { PUBLISH_CAPABILITIES } from './publish-capabilities.ts';
import {
  publishRoleComposable,
  publishRoleDelivers,
  publishRoleMediaIssue,
  publishRoleState,
  publishRoleWarning,
  PUBLISH_VARIANT_MEDIA_ROLES,
} from './publish-variant-media.ts';
import {
  urlPostMedia,
  SIGNAL_DRIVE_IMAGE_MAX_BYTES,
  type SignalPostMedia,
} from './signal-media.ts';

const driveCover = (overrides: Partial<SignalPostMedia> = {}): SignalPostMedia => ({
  source: 'DRIVE',
  url: 'https://drive.google.com/file/d/cover/view',
  driveFileId: 'cover',
  driveName: 'cover.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
  driveVersion: '7',
  driveModifiedAt: '2026-03-01T12:00:00.000Z',
  driveChecksum: null,
  driveVerifiedAt: '2026-03-02T12:00:00.000Z',
  ...overrides,
});

describe('which platform holds a role, and which one sends it', () => {
  it('records a role only where the provider names the field', () => {
    expect(publishRoleState('instagram', 'COVER_IMAGE')).toBe('UNVERIFIED');
    expect(publishRoleState('youtube', 'THUMBNAIL')).toBe('UNVERIFIED');
    expect(publishRoleState('instagram', 'THUMBNAIL')).toBe('ABSENT');
    expect(publishRoleState('youtube', 'COVER_IMAGE')).toBe('ABSENT');
    expect(publishRoleState('linkedin', 'COVER_IMAGE')).toBe('ABSENT');
  });

  it('lets a named role be composed and an absent one not', () => {
    expect(publishRoleComposable('instagram', 'COVER_IMAGE')).toBe(true);
    expect(publishRoleComposable('youtube', 'THUMBNAIL')).toBe(true);
    expect(publishRoleComposable('twitter', 'COVER_IMAGE')).toBe(false);
    expect(publishRoleComposable('twitter', 'THUMBNAIL')).toBe(false);
  });

  /**
   * The agreement the card's last acceptance criterion is about.
   *
   * A capability flag is true exactly where the role state is `VERIFIED`, so the table the whole app
   * reads for what the provider accepts and the record of *why* it does cannot drift apart. Today
   * nothing is verified, which is why every flag is false — and this assertion is what would fail if
   * someone flipped one without recording the evidence.
   */
  it('delivers a role exactly where the capability flag and the verified state agree', () => {
    for (const capability of Object.values(PUBLISH_CAPABILITIES))
      for (const role of PUBLISH_VARIANT_MEDIA_ROLES)
        expect(publishRoleDelivers(capability, role)).toBe(
          publishRoleState(capability.platform, role) === 'VERIFIED',
        );
    // And no role is delivered at all, which is the will-not-build C76 recorded.
    expect(
      Object.values(PUBLISH_CAPABILITIES).some(
        (capability) => capability.coverImage || capability.thumbnail,
      ),
    ).toBe(false);
  });

  it('says which of the two reasons a role is not sent', () => {
    expect(publishRoleWarning(PUBLISH_CAPABILITIES.instagram, 'COVER_IMAGE')).toMatch(
      /names a cover image field for Instagram, but the live probe has not verified/,
    );
    expect(publishRoleWarning(PUBLISH_CAPABILITIES.youtube, 'THUMBNAIL')).toMatch(
      /names a thumbnail field for YouTube, but the live probe has not verified/,
    );
    // A platform the provider defines no field for is a different sentence, because it is a
    // different fact and only one of the two might ever change.
    expect(publishRoleWarning(PUBLISH_CAPABILITIES.twitter, 'THUMBNAIL')).toBe(
      'X takes no thumbnail from this provider, so this one is stored and not sent.',
    );
  });

  it('names a role that is delivered as delivered', () => {
    expect(
      publishRoleDelivers({ ...PUBLISH_CAPABILITIES.youtube, thumbnail: true }, 'THUMBNAIL'),
    ).toBe(true);
  });
});

describe('what a role reference may be', () => {
  it('accepts an image from either source', () => {
    expect(publishRoleMediaIssue(driveCover(), 'COVER_IMAGE')).toBeNull();
    expect(
      publishRoleMediaIssue(urlPostMedia('https://cdn.example.com/cover.png'), 'COVER_IMAGE'),
    ).toBeNull();
    // An extensionless address says nothing about its kind, so it is accepted rather than refused on
    // a guess — the same answer preflight gives an unclassifiable post media item.
    expect(
      publishRoleMediaIssue(urlPostMedia('https://cdn.example.com/cover'), 'THUMBNAIL'),
    ).toBeNull();
  });

  it('refuses a video, a PDF, and an oversized image', () => {
    expect(publishRoleMediaIssue(driveCover({ mimeType: 'video/mp4' }), 'COVER_IMAGE')).toMatch(
      /cover image has to be an image/,
    );
    expect(publishRoleMediaIssue(driveCover({ mimeType: 'application/pdf' }), 'THUMBNAIL')).toMatch(
      /thumbnail has to be an image/,
    );
    expect(
      publishRoleMediaIssue(
        driveCover({ sizeBytes: SIGNAL_DRIVE_IMAGE_MAX_BYTES + 1 }),
        'COVER_IMAGE',
      ),
    ).toMatch(/may be up to 8.0 MB/);
    expect(
      publishRoleMediaIssue(urlPostMedia('https://cdn.example.com/clip.mp4'), 'COVER_IMAGE'),
    ).toMatch(/that address is a video/);
  });

  /** The C74 cross-field rule first, so a role cannot be half a Drive reference. */
  it('refuses a descriptor that breaks the one media rule', () => {
    expect(publishRoleMediaIssue(driveCover({ driveName: null }), 'COVER_IMAGE')).toMatch(
      /needs the Drive file name/,
    );
    expect(
      publishRoleMediaIssue(
        driveCover({ driveVersion: null, driveModifiedAt: null, driveChecksum: null }),
        'COVER_IMAGE',
      ),
    ).toMatch(/at least one version signal/);
  });
});

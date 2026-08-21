import { describe, expect, it } from 'vitest';
import {
  parsePostBridgeUploadReservation,
  postBridgeMediaEvidence,
  postBridgePlatformConfigurations,
  postBridgePostBody,
  postBridgeUploadReservationBody,
  validatePostBridgeUploadUrl,
} from './post-bridge-wire.ts';
import type { PublishRequest } from './provider.ts';

const base = {
  caption: 'Scheduled caption',
  scheduledInstant: '2026-08-24T22:00:00.000Z',
  timezone: 'America/New_York',
  targets: [{ accountId: 85300, platform: 'facebook' }],
};

describe('Post Bridge media wire shapes', () => {
  it('keeps URL-only serialization byte-for-byte compatible and emits no media key', () => {
    const request: PublishRequest = { ...base, mediaUrls: ['https://cdn.test/image.png'] };
    expect(postBridgePostBody(request)).toEqual({
      caption: base.caption,
      media_urls: ['https://cdn.test/image.png'],
      scheduled_at: base.scheduledInstant,
      social_accounts: [85300],
    });
    expect(postBridgePostBody(request)).not.toHaveProperty('media');
  });

  it('serializes uploaded ids as media and sends no media_urls', () => {
    const request: PublishRequest = { ...base, mediaIds: ['provider-media-1'] };
    expect(postBridgePostBody(request)).toEqual({
      caption: base.caption,
      media: ['provider-media-1'],
      scheduled_at: base.scheduledInstant,
      social_accounts: [85300],
    });
    expect(postBridgePostBody(request)).not.toHaveProperty('media_urls');
  });

  it('builds and parses the verified reservation fields', () => {
    expect(
      postBridgeUploadReservationBody({ name: 'image.png', mimeType: 'image/png', sizeBytes: 136 }),
    ).toEqual({ name: 'image.png', mime_type: 'image/png', size_bytes: 136 });
    expect(
      parsePostBridgeUploadReservation({
        media_id: 'media-1',
        upload_url: 'https://storage.test/object?signature=secret',
      }),
    ).toEqual({
      mediaId: 'media-1',
      uploadUrl: 'https://storage.test/object?signature=secret',
    });
    expect(() => parsePostBridgeUploadReservation({ media_id: 'media-1' })).toThrow(
      /without a media id and signed upload URL/,
    );
  });

  it('accepts only HTTPS upload URLs without credentials or fragments', () => {
    expect(
      validatePostBridgeUploadUrl('https://storage.test/object?signature=secret').hostname,
    ).toBe('storage.test');
    for (const url of [
      'http://storage.test/object',
      'https://user:pass@storage.test/object',
      'https://storage.test/object#fragment',
      'https://localhost/object',
      'https://127.0.0.1/object',
      'https://uploads.internal/object',
      'not a URL',
    ])
      expect(() => validatePostBridgeUploadUrl(url)).toThrow();
  });

  /**
   * The vendor's field names, asserted without contacting the vendor.
   *
   * `document_title` is the one this card owed a test: it is what makes a LinkedIn PDF a document
   * post, it is the only media-role behaviour C73 verified live, and it used to live inside the
   * adapter where only manual QA could reach it.
   */
  it('emits the vendor field names, LinkedIn document titles included', () => {
    expect(
      postBridgePlatformConfigurations({
        ...base,
        mediaIds: ['provider-media-1'],
        platformConfigurations: [
          { platform: 'linkedin', title: 'Q3 report' },
          { platform: 'youtube', title: 'The talk', caption: 'Tailored' },
          { platform: 'twitter', firstComment: 'gholmesdesigns.com' },
          { platform: 'instagram', story: true },
        ],
      } as PublishRequest),
    ).toEqual({
      linkedin: { document_title: 'Q3 report' },
      youtube: { caption: 'Tailored', title: 'The talk' },
      twitter: { first_comment: 'gholmesdesigns.com' },
      instagram: { placement: 'story' },
    });
  });

  it('sends no configuration key at all for an untailored post', () => {
    expect(
      postBridgePlatformConfigurations({ ...base, mediaUrls: [] } as PublishRequest),
    ).toBeUndefined();
    expect(
      postBridgePlatformConfigurations({
        ...base,
        mediaUrls: [],
        platformConfigurations: [],
      } as PublishRequest),
    ).toBeUndefined();
  });

  /**
   * No `cover_image` and no `thumbnail`, deliberately.
   *
   * Both are named by Post Bridge's OpenAPI and neither was verified by the live probe, and
   * inventing a wire field from a document is what C76 put out of scope. A stored role warns in the
   * preview instead. This assertion is the guard: adding either key here without a dated §14 result
   * makes it fail.
   */
  it('carries no unverified media role onto the wire', () => {
    const fields = postBridgePlatformConfigurations({
      ...base,
      mediaIds: ['provider-media-1'],
      platformConfigurations: [
        { platform: 'instagram', caption: 'Tailored' },
        { platform: 'youtube', title: 'The talk' },
      ],
    } as PublishRequest) as Record<string, Record<string, unknown>>;
    expect(Object.keys(fields.instagram as object)).toEqual(['caption']);
    expect(Object.keys(fields.youtube as object)).toEqual(['title']);
  });

  it('keeps provider media ids distinct from public URLs in describe evidence', () => {
    expect(
      postBridgeMediaEvidence([
        'provider-media-1',
        'https://cdn.test/legacy.jpg',
        { id: 'provider-media-2', url: 'https://storage.test/object' },
      ]),
    ).toEqual({
      mediaUrls: ['https://cdn.test/legacy.jpg', 'https://storage.test/object'],
      mediaIds: ['provider-media-1', 'provider-media-2'],
    });
  });
});

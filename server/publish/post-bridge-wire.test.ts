import { describe, expect, it } from 'vitest';
import {
  parsePostBridgeUploadReservation,
  postBridgeMediaEvidence,
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

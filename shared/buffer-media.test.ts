import { describe, expect, it } from 'vitest';
import { bufferMediaPlan, BUFFER_MEDIA_ROUTE_SUMMARY } from './buffer-media.ts';
import { bufferCapabilityFor } from './buffer-capabilities.ts';
import type { PublishChannelContent } from './publish.ts';
import { urlPostMedia, type SignalPostMedia } from './signal-media.ts';

const content = (
  mediaUrls: string[],
  overrides: Partial<PublishChannelContent> = {},
): PublishChannelContent => ({
  caption: 'Caption',
  mediaUrls,
  postKind: 'POST',
  discloseSyntheticMedia: false,
  sources: {
    caption: 'BASE',
    mediaUrls: 'BASE',
    postKind: 'BASE',
    title: 'BASE',
    firstComment: 'BASE',
    thumbnail: 'BASE',
    discloseSyntheticMedia: 'BASE',
    coverImage: 'BASE',
  },
  deliveryMode: 'MANUAL_FINISH',
  ...overrides,
});

describe('Buffer media planning', () => {
  const capability = bufferCapabilityFor('tiktok', 'notification')!;

  it('refuses Drive references before any wire is built', () => {
    const drive: SignalPostMedia = {
      source: 'DRIVE',
      url: 'https://drive.google.com/file/d/abc/view',
      driveFileId: 'abc',
      driveName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4,
      driveVersion: '1',
      driveModifiedAt: '2026-03-01T12:00:00.000Z',
      driveChecksum: 'd41d8cd98f00b204e9800998ecf8427e',
      driveVerifiedAt: '2026-08-20T09:00:00.000Z',
    };
    const plan = bufferMediaPlan({
      capability,
      platform: 'tiktok',
      schedulingType: 'notification',
      content: content([drive.url]),
      media: [drive],
    });
    expect(plan.bufferWire).toBeUndefined();
    expect(plan.refusals[0]).toMatch(/Drive/);
  });

  it('carries no assets under notification scheduling', () => {
    const plan = bufferMediaPlan({
      capability,
      platform: 'tiktok',
      schedulingType: 'notification',
      content: content([]),
      media: [],
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.bufferWire?.assets).toEqual([]);
    expect(plan.warnings[0]).toMatch(/text only/i);
  });

  it('builds automatic TikTok assets from public URLs', () => {
    const automatic = bufferCapabilityFor('tiktok', 'automatic')!;
    const url = 'https://cdn.example.com/clip.mp4';
    const plan = bufferMediaPlan({
      capability: automatic,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([url]),
      media: [urlPostMedia(url)],
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.bufferWire?.assets).toEqual([{ video: { url } }]);
    expect(plan.warnings).toContain(BUFFER_MEDIA_ROUTE_SUMMARY);
  });

  it('warns on query strings and refuses automatic YouTube', () => {
    const signed = 'https://cdn.example.com/a.mp4?token=1';
    const warned = bufferMediaPlan({
      capability: bufferCapabilityFor('tiktok', 'automatic')!,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([signed]),
      media: [urlPostMedia(signed)],
    });
    expect(warned.warnings.some((warning) => warning.includes('query'))).toBe(true);

    const youtube = bufferMediaPlan({
      capability: bufferCapabilityFor('youtube', 'automatic')!,
      platform: 'youtube',
      schedulingType: 'automatic',
      content: content(['https://cdn.example.com/a.mp4']),
      media: [urlPostMedia('https://cdn.example.com/a.mp4')],
    });
    expect(youtube.refusals[0]).toMatch(/not available yet/i);
  });
});

import { describe, expect, it } from 'vitest';
import {
  bufferMediaPlan,
  driveDirectDownloadUrl,
  BUFFER_MEDIA_ROUTE_SUMMARY,
} from './buffer-media.ts';
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

  const driveVideo: SignalPostMedia = {
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

  it('refuses Drive references before any wire is built', () => {
    const plan = bufferMediaPlan({
      capability,
      platform: 'tiktok',
      schedulingType: 'notification',
      content: content([driveVideo.url]),
      media: [driveVideo],
    });
    expect(plan.bufferWire).toBeUndefined();
    expect(plan.refusals[0]).toMatch(/Drive/);
    // Notification scheduling never touches media, so the override would have nothing to affect.
    expect(plan.driveOverridable).toBe(false);
  });

  it('marks a Drive reference overridable under automatic scheduling without accepting the override', () => {
    const automatic = bufferCapabilityFor('tiktok', 'automatic')!;
    const plan = bufferMediaPlan({
      capability: automatic,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([driveVideo.url]),
      media: [driveVideo],
    });
    expect(plan.driveOverridable).toBe(true);
    expect(plan.bufferWire).toBeUndefined();
    expect(plan.refusals[0]).toMatch(/Drive/);
  });

  it('converts a Drive reference to a direct-download link under the override', () => {
    const automatic = bufferCapabilityFor('tiktok', 'automatic')!;
    const plan = bufferMediaPlan({
      capability: automatic,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([driveVideo.url]),
      media: [driveVideo],
      driveOverride: true,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.driveOverridable).toBe(true);
    expect(plan.bufferWire?.assets).toEqual([{ video: { url: driveDirectDownloadUrl('abc') } }]);
    expect(plan.warnings.some((warning) => warning.includes('direct-download'))).toBe(true);
  });

  it('refuses an overridden Drive reference with no file id', () => {
    const automatic = bufferCapabilityFor('tiktok', 'automatic')!;
    const noFileId: SignalPostMedia = { ...driveVideo, driveFileId: null };
    const plan = bufferMediaPlan({
      capability: automatic,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([noFileId.url]),
      media: [noFileId],
      driveOverride: true,
    });
    expect(plan.bufferWire).toBeUndefined();
    expect(plan.refusals[0]).toMatch(/without a Drive file id/);
  });

  it('refuses an overridden Drive reference whose MIME type does not classify', () => {
    const automatic = bufferCapabilityFor('tiktok', 'automatic')!;
    const unclassified: SignalPostMedia = { ...driveVideo, mimeType: 'application/zip' };
    const plan = bufferMediaPlan({
      capability: automatic,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([unclassified.url]),
      media: [unclassified],
      driveOverride: true,
    });
    expect(plan.bufferWire).toBeUndefined();
    expect(plan.refusals[0]).toMatch(/cannot classify/);
  });

  it('builds the direct-download address from the file id', () => {
    expect(driveDirectDownloadUrl('abc 123')).toBe(
      'https://drive.google.com/uc?export=download&id=abc%20123',
    );
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

    const hashed = 'https://cdn.example.com/a.mp4#part';
    const hashWarned = bufferMediaPlan({
      capability: bufferCapabilityFor('tiktok', 'automatic')!,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([hashed]),
      media: [urlPostMedia(hashed)],
    });
    expect(hashWarned.warnings.some((warning) => warning.includes('fragment'))).toBe(true);

    const youtube = bufferMediaPlan({
      capability: bufferCapabilityFor('youtube', 'automatic')!,
      platform: 'youtube',
      schedulingType: 'automatic',
      content: content(['https://cdn.example.com/a.mp4']),
      media: [urlPostMedia('https://cdn.example.com/a.mp4')],
    });
    expect(youtube.refusals[0]).toMatch(/not available yet/i);
  });

  it('maps image and document assets and carries title metadata', () => {
    const automatic = bufferCapabilityFor('tiktok', 'automatic')!;
    const imageUrl = 'https://cdn.example.com/photo.jpg';
    const pdfUrl = 'https://cdn.example.com/brief.pdf';
    const imagePlan = bufferMediaPlan({
      capability: automatic,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([imageUrl], { title: 'TikTok title' }),
      media: [urlPostMedia(imageUrl)],
    });
    expect(imagePlan.bufferWire?.assets).toEqual([{ image: { url: imageUrl } }]);
    expect(imagePlan.bufferWire?.metadata).toEqual({ tiktok: { title: 'TikTok title' } });

    const pdfPlan = bufferMediaPlan({
      capability: automatic,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([pdfUrl]),
      media: [urlPostMedia(pdfUrl)],
    });
    expect(pdfPlan.bufferWire?.assets).toEqual([{ document: { url: pdfUrl } }]);

    const youtubeNotification = bufferCapabilityFor('youtube', 'notification')!;
    const youtubePlan = bufferMediaPlan({
      capability: youtubeNotification,
      platform: 'youtube',
      schedulingType: 'notification',
      content: content([], { title: 'YouTube title' }),
      media: [],
    });
    expect(youtubePlan.bufferWire?.metadata).toEqual({ youtube: { title: 'YouTube title' } });
  });

  it('refuses URLs whose kind cannot be classified', () => {
    const unknownUrl = 'https://cdn.example.com/asset';
    const plan = bufferMediaPlan({
      capability: bufferCapabilityFor('tiktok', 'automatic')!,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([unknownUrl]),
      media: [urlPostMedia(unknownUrl)],
    });
    expect(plan.bufferWire).toBeUndefined();
    expect(plan.refusals[0]).toMatch(/cannot classify/i);
  });

  it('synthesizes URL rows when media is not stored on the post', () => {
    const url = 'https://cdn.example.com/clip.mp4';
    const plan = bufferMediaPlan({
      capability: bufferCapabilityFor('tiktok', 'automatic')!,
      platform: 'tiktok',
      schedulingType: 'automatic',
      content: content([url]),
      media: [],
    });
    expect(plan.bufferWire?.assets).toEqual([{ video: { url } }]);
  });
});

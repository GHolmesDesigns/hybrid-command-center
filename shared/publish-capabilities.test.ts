import { describe, expect, it } from 'vitest';
import { SIGNAL_CHANNELS, SIGNAL_FORMATS, type SignalFormat } from './signal.ts';
import {
  publishCapabilityFor,
  publishKindSupported,
  publishPlatformFor,
  publishPostKindFor,
  PUBLISH_CAPABILITIES,
  PUBLISH_PLATFORMS,
  PUBLISH_POST_KINDS,
  PUBLISH_POST_KIND_LABEL,
  SIGNAL_CHANNEL_PLATFORM,
} from './publish-capabilities.ts';

describe('the provider capability contract', () => {
  it('answers for every Signal channel, mapping only blog to no platform at all', () => {
    for (const channel of SIGNAL_CHANNELS) {
      const platform = SIGNAL_CHANNEL_PLATFORM[channel];
      expect(publishPlatformFor(channel)).toBe(platform);
      if (channel === 'blog') expect(platform).toBeNull();
      else expect(publishCapabilityFor(platform as string)).toBeDefined();
    }
    expect(SIGNAL_CHANNELS.filter((channel) => SIGNAL_CHANNEL_PLATFORM[channel] === null)).toEqual([
      'blog',
    ]);
  });

  it('fails closed on a platform and a channel it does not record', () => {
    expect(publishCapabilityFor('mastodon')).toBeUndefined();
    expect(publishPlatformFor('mastodon')).toBeUndefined();
    // `undefined` and `null` are different answers and the difference is the whole point: one is
    // an unrecorded platform that must refuse, the other is blog, recorded as reaching nothing.
    expect(publishPlatformFor('blog')).toBeNull();
  });

  it('gives every platform a complete answer for every post shape', () => {
    for (const platform of PUBLISH_PLATFORMS) {
      const capability = PUBLISH_CAPABILITIES[platform];
      expect(capability.platform).toBe(platform);
      expect(capability.label).not.toBe(platform);
      expect(capability.captionMax).toBeGreaterThan(0);
      // No provider draft anywhere: submitting an existing Post Bridge draft is broken upstream.
      expect(capability.providerDraft).toBe(false);
      // Tailoring is per platform, never per account.
      expect(capability.platformContentOverride).toBe(true);
      expect(capability.accountContentOverride).toBe(false);
      expect(capability.syntheticMediaDisclosure).toBe('IN_CAPTION');
      expect(PUBLISH_POST_KINDS.every((kind) => capability.kinds[kind] !== undefined)).toBe(true);
      // A standard post is the one shape every platform takes.
      expect(publishKindSupported(capability.kinds.POST)).toBe(true);
      for (const kind of PUBLISH_POST_KINDS) {
        const support = capability.kinds[kind];
        if (!publishKindSupported(support)) {
          expect(support.media.max).toBe(0);
          continue;
        }
        expect(support.media.min).toBeGreaterThanOrEqual(0);
        if (support.media.max !== null)
          expect(support.media.max).toBeGreaterThanOrEqual(support.media.min);
      }
    }
  });

  it('records the limits the working integration measured', () => {
    expect(PUBLISH_CAPABILITIES.twitter.captionMax).toBe(280);
    expect(PUBLISH_CAPABILITIES.twitter.captionOverLimitRefuses).toBe(true);
    expect(PUBLISH_CAPABILITIES.twitter.stripsLinks).toBe(true);
    expect(PUBLISH_CAPABILITIES.twitter.firstComment.supported).toBe(true);
    expect(PUBLISH_CAPABILITIES.bluesky.captionMax).toBe(300);
    expect(PUBLISH_CAPABILITIES.bluesky.captionOverLimitRefuses).toBe(true);
    expect(PUBLISH_CAPABILITIES.facebook.captionOverLimitRefuses).toBe(false);
    expect(PUBLISH_CAPABILITIES.linkedin.kinds.POST.media.pdf).toBe('DOCUMENT_POST');
    expect(PUBLISH_CAPABILITIES.instagram.kinds.POST.media.pdf).toBe('DROPPED');
    expect(PUBLISH_CAPABILITIES.youtube.kinds.POST.media.video).toBe('REQUIRED_ALONE');
    expect(PUBLISH_CAPABILITIES.youtube.title).toEqual({
      supported: true,
      required: true,
      maxLength: 100,
    });
    expect(PUBLISH_CAPABILITIES.google_business.kinds.POST.media.video).toBe('FORBIDDEN');
  });

  it('keeps a story a story: one item, and a caption that never reaches the reader', () => {
    for (const platform of PUBLISH_PLATFORMS) {
      const story = PUBLISH_CAPABILITIES[platform].kinds.STORY;
      if (!publishKindSupported(story)) continue;
      expect(story.media).toMatchObject({ min: 1, max: 1 });
      expect(story.captionReachesReader).toBe(false);
    }
    expect(publishKindSupported(PUBLISH_CAPABILITIES.instagram.kinds.STORY)).toBe(true);
    expect(publishKindSupported(PUBLISH_CAPABILITIES.facebook.kinds.STORY)).toBe(true);
    expect(publishKindSupported(PUBLISH_CAPABILITIES.twitter.kinds.STORY)).toBe(false);
  });

  it('records TikTok as reachable automatically and by hand, and nothing else as manual', () => {
    expect(PUBLISH_CAPABILITIES.tiktok.kinds.POST).toMatchObject({
      automatic: true,
      manualFinish: true,
    });
    const manualElsewhere = PUBLISH_PLATFORMS.filter(
      (platform) =>
        platform !== 'tiktok' &&
        PUBLISH_POST_KINDS.some((kind) => PUBLISH_CAPABILITIES[platform].kinds[kind].manualFinish),
    );
    expect(manualElsewhere).toEqual([]);
  });

  it('submits every planned format as one of the four shapes, and labels each of them', () => {
    const kinds = SIGNAL_FORMATS.map(publishPostKindFor);
    expect(kinds.every((kind) => PUBLISH_POST_KINDS.includes(kind))).toBe(true);
    expect(publishPostKindFor('CAROUSEL')).toBe('CAROUSEL');
    expect(publishPostKindFor('REEL')).toBe('REEL');
    expect(publishPostKindFor('STORY')).toBe('STORY');
    expect(publishPostKindFor('WHITEBOARD_VIDEO')).toBe('POST');
    expect(publishPostKindFor('TEXT')).toBe('POST');
    // Every shape has words for it, so a refusal can name what the post is trying to be.
    for (const kind of PUBLISH_POST_KINDS) expect(PUBLISH_POST_KIND_LABEL[kind]).toBeTruthy();
    // The three provider shapes are the only formats that leave `POST`.
    expect(
      SIGNAL_FORMATS.filter((format) => publishPostKindFor(format as SignalFormat) !== 'POST'),
    ).toEqual(['CAROUSEL', 'REEL', 'STORY']);
  });
});

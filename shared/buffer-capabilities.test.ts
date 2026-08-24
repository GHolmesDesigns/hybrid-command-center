import { describe, expect, it } from 'vitest';
import {
  bufferCapabilityFor,
  DEFAULT_BUFFER_SCHEDULING_TYPE,
  publishCapabilityForProvider,
} from './buffer-capabilities.ts';
import { publishCapabilityFor, publishKindSupported } from './publish-capabilities.ts';
import { BUFFER_PROVIDER } from './buffer.ts';

describe('Buffer publish capabilities', () => {
  it('defaults scheduling type to notification', () => {
    expect(DEFAULT_BUFFER_SCHEDULING_TYPE).toBe('notification');
  });

  it('answers only for TikTok and YouTube', () => {
    expect(bufferCapabilityFor('tiktok', 'notification')).toBeDefined();
    expect(bufferCapabilityFor('youtube', 'notification')).toBeDefined();
    expect(bufferCapabilityFor('twitter', 'notification')).toBeUndefined();
  });

  it('keeps notification TikTok text-only while automatic TikTok requires media', () => {
    const notification = bufferCapabilityFor('tiktok', 'notification');
    const automatic = bufferCapabilityFor('tiktok', 'automatic');
    expect(notification?.kinds.POST.media.min).toBe(0);
    expect(automatic?.kinds.POST.media.min).toBe(1);
    expect(automatic?.kinds.POST.automatic).toBe(true);
    expect(notification?.kinds.POST.manualFinish).toBe(true);
  });

  it('keeps automatic YouTube fail-closed in the capability table', () => {
    const automatic = bufferCapabilityFor('youtube', 'automatic');
    expect(automatic?.kinds.POST).toMatchObject({ automatic: false, manualFinish: false });
    expect(publishKindSupported(automatic!.kinds.REEL)).toBe(false);
  });

  it('selects Buffer versus Post Bridge by provider', () => {
    const postBridge = publishCapabilityForProvider(undefined, 'tiktok');
    const buffer = publishCapabilityForProvider(BUFFER_PROVIDER, 'tiktok');
    expect(postBridge?.kinds.POST.media.min).toBeGreaterThan(0);
    expect(buffer?.kinds.POST.media.min).toBe(0);
    expect(
      publishCapabilityForProvider(BUFFER_PROVIDER, 'tiktok', 'automatic')?.kinds.POST.media.min,
    ).toBe(1);
    expect(publishCapabilityFor('tiktok')).toEqual(postBridge);
  });
});

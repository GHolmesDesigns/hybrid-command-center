import { describe, expect, it } from 'vitest';
import {
  BUFFER_UNAVAILABLE_LABEL,
  bufferPlatformForService,
  bufferUnavailableReason,
} from './buffer.ts';

describe('buffer service mapping', () => {
  it('maps only the Buffer-route platforms from Signal channels', () => {
    expect(bufferPlatformForService('tiktok')).toBe('tiktok');
    expect(bufferPlatformForService('youtube')).toBe('youtube');
    expect(bufferPlatformForService('twitter')).toBeUndefined();
  });

  it('names unavailable channel states in priority order', () => {
    expect(
      bufferUnavailableReason({
        isDisconnected: true,
        isLocked: true,
        isQueuePaused: true,
      }),
    ).toBe(BUFFER_UNAVAILABLE_LABEL.disconnected);
    expect(
      bufferUnavailableReason({
        isDisconnected: false,
        isLocked: true,
        isQueuePaused: true,
      }),
    ).toBe(BUFFER_UNAVAILABLE_LABEL.locked);
    expect(
      bufferUnavailableReason({
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: true,
      }),
    ).toBe(BUFFER_UNAVAILABLE_LABEL.queuePaused);
  });
});

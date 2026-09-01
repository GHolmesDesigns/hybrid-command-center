import { describe, expect, it } from 'vitest';
import {
  BUFFER_SIGNAL_CHANNELS,
  BUFFER_UNAVAILABLE_LABEL,
  bufferPlatformForService,
  bufferUnavailableReason,
} from './buffer.ts';

describe('buffer service mapping', () => {
  it('does not map current Signal platforms to Buffer after the ownership decision', () => {
    expect(BUFFER_SIGNAL_CHANNELS).toEqual([]);
    expect(bufferPlatformForService('tiktok')).toBeUndefined();
    expect(bufferPlatformForService('youtube')).toBeUndefined();
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
    expect(
      bufferUnavailableReason({
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: false,
      }),
    ).toBeUndefined();
  });
});

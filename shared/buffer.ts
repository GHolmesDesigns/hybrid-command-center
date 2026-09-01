import type { PublishPlatform } from './publish-capabilities.ts';
import type { SignalChannel } from './signal.ts';

/** The provider id every Buffer route stores on a target or publication. */
export const BUFFER_PROVIDER = 'buffer';

/**
 * Production Buffer writes remain closed until the owner-run C83 round trip records the exact
 * connected channels. Tests inject a mock write provider; changing this value requires that dated
 * evidence and its publishing-record update in the same change.
 */
export const BUFFER_WRITE_EVIDENCE = {
  enabled: false,
  reason:
    'Buffer publishing is built but not production-enabled: the owner-run C83 create, read, edit, and cleanup evidence has not been recorded for the connected channels.',
} as const;

/** The only origin this app posts Buffer GraphQL to. */
export const BUFFER_API_URL = 'https://api.buffer.com';

export const BUFFER_POSTS_PAGE_SIZE = 50;
export const BUFFER_POSTS_PAGE_MAX = 20;

/**
 * Buffer's account vocabulary is retained for historical publications, but it no longer owns a
 * current Signal route. C155/#447 made TikTok and YouTube Post Bridge-owned; a Buffer credential or
 * a stale Buffer account must not silently become a new delivery route.
 */
const BUFFER_SERVICE_PLATFORM = new Map<string, PublishPlatform>();

/** Whether a Buffer service name maps to a platform this app publishes to. */
export const bufferPlatformForService = (service: string): PublishPlatform | undefined =>
  BUFFER_SERVICE_PLATFORM.get(service);

/** No current Signal channels route through Buffer; historical Buffer lifecycle support remains. */
export const BUFFER_SIGNAL_CHANNELS: SignalChannel[] = [];

export const BUFFER_UNAVAILABLE_LABEL = {
  disconnected: 'Disconnected from Buffer',
  locked: 'Locked in Buffer',
  queuePaused: 'Queue paused in Buffer',
  unknownService: 'Unknown Buffer service',
} as const;

/** The first unavailable state on a channel, in priority order, or nothing when it may be used. */
export const bufferUnavailableReason = (channel: {
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
}): string | undefined => {
  if (channel.isDisconnected) return BUFFER_UNAVAILABLE_LABEL.disconnected;
  if (channel.isLocked) return BUFFER_UNAVAILABLE_LABEL.locked;
  if (channel.isQueuePaused) return BUFFER_UNAVAILABLE_LABEL.queuePaused;
  return undefined;
};

import { SIGNAL_CHANNEL_PLATFORM, type PublishPlatform } from './publish-capabilities.ts';
import type { SignalChannel } from './signal.ts';

/** The provider id every Buffer route stores on a target or publication. */
export const BUFFER_PROVIDER = 'buffer';

/** The only origin this app posts Buffer GraphQL to. */
export const BUFFER_API_URL = 'https://api.buffer.com';

export const BUFFER_POSTS_PAGE_SIZE = 50;
export const BUFFER_POSTS_PAGE_MAX = 20;

/**
 * Buffer `Service` enum values this app maps to Signal platforms.
 *
 * Only the platforms that route through Buffer today — TikTok and YouTube — are admitted. Built
 * from `SIGNAL_CHANNEL_PLATFORM` rather than invented; anything else fails closed.
 */
const BUFFER_ROUTE_CHANNELS: SignalChannel[] = ['tt', 'yt'];
const BUFFER_SERVICE_PLATFORM = (() => {
  const map = new Map<string, PublishPlatform>();
  for (const channel of BUFFER_ROUTE_CHANNELS) {
    const platform = SIGNAL_CHANNEL_PLATFORM[channel];
    if (platform) map.set(platform, platform);
  }
  return map;
})();

/** Whether a Buffer service name maps to a platform this app publishes to. */
export const bufferPlatformForService = (service: string): PublishPlatform | undefined =>
  BUFFER_SERVICE_PLATFORM.get(service);

/** Signal channels that route through Buffer when the account-cap decision holds. */
export const BUFFER_SIGNAL_CHANNELS = (
  Object.entries(SIGNAL_CHANNEL_PLATFORM) as [SignalChannel, PublishPlatform | null][]
)
  .filter(([, platform]) => platform !== null && BUFFER_SERVICE_PLATFORM.has(platform))
  .map(([channel]) => channel);

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

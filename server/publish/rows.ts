import type {
  DeliveryMode,
  SignalPublication,
  SignalPublicationTarget,
} from '../../shared/publish.ts';
import { publishPlatformFor } from '../../shared/publish-capabilities.ts';
import type { SignalChannel } from '../../shared/signal.ts';

/**
 * Turning publication rows into `SignalPublication`s, shared by the write half and the read half.
 *
 * Split out for the reason `server/signal/rows.ts` is: two callers now read these tables — the
 * publishing service, which also writes them, and the read half the queue-health summary consumes —
 * and a delivery record has to be shaped exactly one way whichever of them asked. A second mapper
 * would be a second answer to "what did the provider say", and the two would drift a column at a
 * time.
 */

export interface PublicationRow {
  id: string;
  post_id: string;
  state: SignalPublication['state'];
  provider: string;
  provider_post_id: string | null;
  scheduled_instant: string;
  timezone: string;
  sent_caption: string;
  sent_channels: string;
  /** NULL only on a row written before these columns existed. See `server/db.ts`. */
  sent_media: string | null;
  sent_configurations: string | null;
  sent_media_sources: string | null;
  sent_account_configurations: string | null;
  sent_provider_media_ids: string | null;
  error: string | null;
  checked_at: string | null;
  /** Written by a check and by nothing else. NULL until the provider has been asked once. */
  checked_state: SignalPublication['state'] | null;
  prior_state: SignalPublication['state'] | null;
  check_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface TargetRow {
  channel: string;
  provider_account_id: number;
  outcome: 'SUCCESS' | 'FAILURE' | null;
  permalink: string | null;
  error: string | null;
  handle: string;
  mode: string;
  manual_completed_at: string | null;
  /** The provider's `post-results` row id. NULL until a check has reported one. */
  post_result_id: string | null;
}

export const toTarget = (row: TargetRow): SignalPublicationTarget => ({
  channel: row.channel as SignalChannel,
  platform: publishPlatformFor(row.channel) ?? null,
  accountId: row.provider_account_id,
  handle: row.handle,
  mode: row.mode as DeliveryMode,
  ...(row.outcome ? { outcome: row.outcome } : {}),
  ...(row.post_result_id ? { resultId: row.post_result_id } : {}),
  ...(row.permalink ? { permalink: row.permalink } : {}),
  ...(row.error ? { error: row.error } : {}),
  ...(row.manual_completed_at ? { manualCompletedAt: row.manual_completed_at } : {}),
});

export const toPublication = (row: PublicationRow, targets: TargetRow[]): SignalPublication => ({
  id: row.id,
  postId: row.post_id,
  state: row.state,
  provider: row.provider,
  ...(row.provider_post_id ? { providerPostId: row.provider_post_id } : {}),
  scheduledInstant: row.scheduled_instant,
  timezone: row.timezone,
  sentCaption: row.sent_caption,
  sentChannels: JSON.parse(row.sent_channels) as SignalChannel[],
  ...(row.sent_media ? { sentMedia: JSON.parse(row.sent_media) as string[] } : {}),
  ...(row.sent_media_sources
    ? {
        sentMediaSources: JSON.parse(row.sent_media_sources) as NonNullable<
          SignalPublication['sentMediaSources']
        >,
      }
    : {}),
  ...(row.sent_provider_media_ids
    ? { sentProviderMediaIds: JSON.parse(row.sent_provider_media_ids) as string[] }
    : {}),
  ...(row.sent_account_configurations
    ? {
        sentAccountConfigurations: JSON.parse(row.sent_account_configurations) as NonNullable<
          SignalPublication['sentAccountConfigurations']
        >,
      }
    : {}),
  ...(row.error ? { error: row.error } : {}),
  targets: targets.map(toTarget),
  ...(row.checked_at ? { checkedAt: row.checked_at } : {}),
  ...(row.checked_state ? { checkedState: row.checked_state } : {}),
  ...(row.prior_state ? { priorState: row.prior_state } : {}),
  checkAttempts: row.check_attempts,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

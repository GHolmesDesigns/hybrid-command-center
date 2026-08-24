import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import { DEFAULT_BUFFER_SCHEDULING_TYPE } from '../../shared/buffer-capabilities.ts';
import {
  BUFFER_POSTS_PAGE_MAX,
  BUFFER_PROVIDER,
  BUFFER_UNAVAILABLE_LABEL,
  bufferPlatformForService,
  bufferUnavailableReason,
} from '../../shared/buffer.ts';
import type { PublishTarget } from './provider.ts';
import { PublishProviderError, PUBLISH_RATE_LIMIT_FALLBACK_SECONDS } from './provider.ts';
import type { BufferChannel, BufferReadProvider } from './buffer/read-provider.ts';
import { BufferProviderError } from './buffer/error.ts';
import { readSyncHealth, recordSyncHealth } from './sync-health.ts';
import { config } from '../config.ts';

export const BUFFER_ACCOUNTS_KEY = 'signal_buffer_accounts';

interface StoredBufferAccountsRecord {
  lastRefreshAt?: string;
  reason?: string;
  organizationId?: string;
}

export interface BufferChannelSnapshot {
  channelId: string;
  service: string;
  platform: string | null;
  displayName: string;
  handle: string;
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
  unavailable?: string;
  snapshotAt: string;
}

export interface BufferAccountsReadResult {
  channels: BufferChannelSnapshot[];
  lastRefreshAt?: string;
  reason?: string;
  organizationId?: string;
}

interface ChannelRow {
  channel_id: string;
  service: string;
  platform: string | null;
  display_name: string;
  handle: string;
  is_disconnected: number;
  is_locked: number;
  is_queue_paused: number;
  unavailable: string | null;
  snapshot_at: string;
}

const toSnapshot = (row: ChannelRow): BufferChannelSnapshot => ({
  channelId: row.channel_id,
  service: row.service,
  platform: row.platform,
  displayName: row.display_name,
  handle: row.handle,
  isDisconnected: row.is_disconnected === 1,
  isLocked: row.is_locked === 1,
  isQueuePaused: row.is_queue_paused === 1,
  ...(row.unavailable ? { unavailable: row.unavailable } : {}),
  snapshotAt: row.snapshot_at,
});

const readRecord = (db: Db): StoredBufferAccountsRecord => {
  const raw = getSetting(db, BUFFER_ACCOUNTS_KEY);
  if (!raw) return {};
  try {
    const stored = JSON.parse(raw) as StoredBufferAccountsRecord;
    return {
      ...(typeof stored.lastRefreshAt === 'string' ? { lastRefreshAt: stored.lastRefreshAt } : {}),
      ...(typeof stored.reason === 'string' ? { reason: stored.reason } : {}),
      ...(typeof stored.organizationId === 'string'
        ? { organizationId: stored.organizationId }
        : {}),
    };
  } catch {
    return {};
  }
};

const writeRecord = (db: Db, record: StoredBufferAccountsRecord): void => {
  setSetting(
    db,
    BUFFER_ACCOUNTS_KEY,
    JSON.stringify({
      ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.organizationId ? { organizationId: record.organizationId } : {}),
    }),
  );
};

export const readBufferChannelSnapshots = (db: Db): BufferChannelSnapshot[] => {
  const rows = db
    .prepare(
      `SELECT channel_id,service,platform,display_name,handle,is_disconnected,is_locked,is_queue_paused,unavailable,snapshot_at
         FROM signal_buffer_channels
        ORDER BY platform, display_name`,
    )
    .all() as unknown as ChannelRow[];
  return rows.map(toSnapshot);
};

class BufferAccountsReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BufferAccountsReadError';
  }
}

export const resolveBufferOrganizationId = (
  organizations: readonly { id: string }[],
  configured = config.buffer.organizationId,
): string => {
  if (configured) {
    if (!organizations.some((organization) => organization.id === configured))
      throw new BufferAccountsReadError(
        'BUFFER_ORGANIZATION_ID does not match any organization on this Buffer account.',
      );
    return configured;
  }
  if (organizations.length === 1) return organizations[0]?.id ?? '';
  if (organizations.length === 0)
    throw new BufferAccountsReadError('Buffer returned no organizations for this account.');
  throw new BufferAccountsReadError(
    'Buffer returned more than one organization; set BUFFER_ORGANIZATION_ID explicitly.',
  );
};

const snapshotFromChannel = (channel: BufferChannel, snapshotAt: string): BufferChannelSnapshot => {
  const platform = bufferPlatformForService(channel.service) ?? null;
  const unavailable =
    platform === null ? BUFFER_UNAVAILABLE_LABEL.unknownService : bufferUnavailableReason(channel);
  return {
    channelId: channel.id,
    service: channel.service,
    platform,
    displayName: channel.name,
    handle: channel.name,
    isDisconnected: channel.isDisconnected,
    isLocked: channel.isLocked,
    isQueuePaused: channel.isQueuePaused,
    ...(unavailable ? { unavailable } : {}),
    snapshotAt,
  };
};

export const bufferTargetsFromDb = (db: Db): PublishTarget[] => {
  let index = 0;
  return readBufferChannelSnapshots(db).flatMap((channel) => {
    if (!channel.platform) return [];
    const target: PublishTarget = {
      id: index,
      provider: BUFFER_PROVIDER,
      accountRef: channel.channelId,
      platform: channel.platform,
      handle: channel.handle,
      name: channel.displayName,
      schedulingType: DEFAULT_BUFFER_SCHEDULING_TYPE,
      ...(channel.unavailable ? { unavailable: channel.unavailable } : {}),
    };
    index += 1;
    return [target];
  });
};

export class BufferAccountsService {
  private readonly db: Db;
  private readonly provider: BufferReadProvider;
  private readonly clock: () => Date;
  readonly available: boolean;
  constructor(db: Db, provider: BufferReadProvider, clock: () => Date = () => new Date()) {
    this.db = db;
    this.provider = provider;
    this.clock = clock;
    this.available = provider.available;
  }

  read(): BufferAccountsReadResult {
    const record = readRecord(this.db);
    return {
      channels: readBufferChannelSnapshots(this.db),
      ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.organizationId ? { organizationId: record.organizationId } : {}),
    };
  }

  /** Channels that may be chosen for publishing — mapped platforms without an unavailable state. */
  selectableTargets(): PublishTarget[] {
    return bufferTargetsFromDb(this.db).filter((target) => !target.unavailable);
  }

  async refresh(): Promise<BufferAccountsReadResult> {
    const stored = this.read();
    if (!this.provider.available) return { ...stored, reason: 'Buffer needs BUFFER_API_KEY.' };
    const waiting = readSyncHealth(this.db)?.rateLimitedUntil;
    if (waiting && Date.parse(waiting) > this.clock().getTime())
      return {
        ...stored,
        reason: `Buffer is rate-limiting this app until ${waiting}. Nothing is asked before then, so the accounts below are the last complete read.`,
      };

    try {
      const { channels, organizationId } = await this.walkChannels();
      return this.replace(channels, organizationId);
    } catch (error) {
      return this.failed(error as Error);
    }
  }

  private async walkChannels(): Promise<{
    channels: BufferChannelSnapshot[];
    organizationId: string;
  }> {
    const account = await this.provider.account();
    const organizationId = resolveBufferOrganizationId(account.organizations);
    const snapshotAt = this.clock().toISOString();
    const channels = (await this.provider.channels(organizationId)).map((channel) =>
      snapshotFromChannel(channel, snapshotAt),
    );
    return { channels, organizationId };
  }

  async readAllPosts(organizationId: string) {
    const posts = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < BUFFER_POSTS_PAGE_MAX; page += 1) {
      const answer = await this.provider.listPosts(organizationId, cursor);
      posts.push(...answer.posts);
      if (!answer.hasNextPage) return posts;
      if (!answer.endCursor || seen.has(answer.endCursor))
        throw new BufferAccountsReadError('Buffer pagination repeated or omitted the next cursor.');
      seen.add(answer.endCursor);
      cursor = answer.endCursor;
    }
    throw new BufferAccountsReadError(
      `Buffer pagination exceeded the ${BUFFER_POSTS_PAGE_MAX}-page safety bound.`,
    );
  }

  private replace(
    channels: BufferChannelSnapshot[],
    organizationId: string,
  ): BufferAccountsReadResult {
    const snapshotAt = this.clock().toISOString();
    const stamped = channels.map((channel) => ({ ...channel, snapshotAt }));
    transaction(this.db, () => {
      const listed = new Set(stamped.map((channel) => channel.channelId));
      const remove = this.db.prepare('DELETE FROM signal_buffer_channels WHERE channel_id=?');
      for (const row of this.db.prepare('SELECT channel_id FROM signal_buffer_channels').all() as {
        channel_id: string;
      }[])
        if (!listed.has(row.channel_id)) remove.run(row.channel_id);
      const upsert = this.db.prepare(
        `INSERT INTO signal_buffer_channels(
           channel_id,service,platform,display_name,handle,is_disconnected,is_locked,is_queue_paused,unavailable,snapshot_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(channel_id) DO UPDATE SET
           service=excluded.service, platform=excluded.platform, display_name=excluded.display_name,
           handle=excluded.handle, is_disconnected=excluded.is_disconnected, is_locked=excluded.is_locked,
           is_queue_paused=excluded.is_queue_paused, unavailable=excluded.unavailable, snapshot_at=excluded.snapshot_at`,
      );
      for (const channel of stamped)
        upsert.run(
          channel.channelId,
          channel.service,
          channel.platform,
          channel.displayName,
          channel.handle,
          channel.isDisconnected ? 1 : 0,
          channel.isLocked ? 1 : 0,
          channel.isQueuePaused ? 1 : 0,
          channel.unavailable ?? null,
          snapshotAt,
        );
      writeRecord(this.db, { lastRefreshAt: snapshotAt, organizationId });
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.buffer-accounts-refresh',
        outcome: 'SUCCESS',
        summary: `Read every Buffer channel: ${stamped.length} ${stamped.length === 1 ? 'channel' : 'channels'} stored.`,
      });
    });
    return this.read();
  }

  private failed(error: Error): BufferAccountsReadResult {
    const rateLimited =
      (error instanceof BufferProviderError && error.rateLimited) ||
      (error instanceof PublishProviderError && error.rateLimited);
    const message = redactSecrets(error.message);
    const reason = `Buffer accounts could not be read, so nothing was replaced: ${message}`;
    const stored = readRecord(this.db);
    transaction(this.db, () => {
      writeRecord(this.db, {
        ...(stored.lastRefreshAt ? { lastRefreshAt: stored.lastRefreshAt } : {}),
        ...(stored.organizationId ? { organizationId: stored.organizationId } : {}),
        reason,
      });
      if (rateLimited) {
        const seconds =
          (error instanceof BufferProviderError
            ? error.retryAfterSeconds
            : (error as PublishProviderError).retryAfterSeconds) ??
          PUBLISH_RATE_LIMIT_FALLBACK_SECONDS;
        recordSyncHealth(this.db, {
          rateLimitedUntil: new Date(this.clock().getTime() + seconds * 1000).toISOString(),
        });
      }
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.buffer-accounts-refresh',
        outcome: 'FAILURE',
        summary: 'Buffer accounts could not be read; no channel row was replaced.',
        error: message,
      });
    });
    return this.read();
  }
}

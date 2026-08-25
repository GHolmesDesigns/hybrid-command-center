import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from '../db.ts';
import { createApp } from '../app.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import type {
  BufferChannel,
  BufferPost,
  BufferPostsPage,
  BufferReadProvider,
} from './buffer/read-provider.ts';
import {
  BufferAccountsService,
  bufferTargetsFromDb,
  resolveBufferOrganizationId,
} from './buffer-accounts.ts';
import { MockPublishProvider } from './mock-provider.ts';

class MockBufferReadProvider implements BufferReadProvider {
  readonly available = true;
  account = vi.fn(async () => ({
    id: 'acct',
    organizations: [{ id: 'org-1', name: 'Studio' }],
  }));
  channels = vi.fn(async () => this.channelRows);
  listPosts = vi.fn(async (): Promise<BufferPostsPage> => ({
    posts: [],
    hasNextPage: false,
    endCursor: null,
  }));
  channelRows: BufferChannel[] = [
    {
      id: 'ch-tiktok',
      name: '@studio',
      service: 'tiktok',
      isDisconnected: false,
      isLocked: false,
      isQueuePaused: false,
    },
    {
      id: 'ch-youtube',
      name: '@studio-yt',
      service: 'youtube',
      isDisconnected: false,
      isLocked: false,
      isQueuePaused: false,
    },
    {
      id: 'ch-paused',
      name: '@paused',
      service: 'youtube',
      isDisconnected: false,
      isLocked: false,
      isQueuePaused: true,
    },
  ];
}

let db: Db;
const NOW = new Date('2030-01-02T00:00:00.000Z');
const clock = () => NOW;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('BufferAccountsService', () => {
  it('replaces the generation atomically and records one integration event', async () => {
    const provider = new MockBufferReadProvider();
    const service = new BufferAccountsService(db, provider, clock);
    expect(service.read().channels).toEqual([]);

    const refreshed = await service.refresh();
    expect(refreshed.channels).toHaveLength(3);
    expect(refreshed.lastRefreshAt).toBe(NOW.toISOString());
    expect(service.selectableTargets()).toHaveLength(2);

    const event = listIntegrationEvents(db, { limit: 1 })[0];
    expect(event?.operation).toBe('signal.buffer-accounts-refresh');
    expect(event?.outcome).toBe('SUCCESS');
  });

  it('coalesces overlapping refresh calls into one provider walk', async () => {
    const provider = new MockBufferReadProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.channels = vi.fn(async () => {
      await gate;
      return provider.channelRows;
    });
    const service = new BufferAccountsService(db, provider, clock);
    const first = service.refresh();
    const second = service.refresh();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(provider.channels).toHaveBeenCalledTimes(1);
    expect(a.channels).toHaveLength(3);
    expect(b.channels).toHaveLength(3);
    expect(
      listIntegrationEvents(db).filter(
        (event) => event.operation === 'signal.buffer-accounts-refresh',
      ),
    ).toHaveLength(1);
  });

  it('keeps the prior generation when the provider refuses', async () => {
    const provider = new MockBufferReadProvider();
    const service = new BufferAccountsService(db, provider, clock);
    await service.refresh();
    provider.account.mockRejectedValueOnce(
      new Error('Buffer GraphQL error (UNAUTHORIZED): bad key'),
    );
    const failed = await service.refresh();
    expect(failed.channels).toHaveLength(3);
    expect(failed.reason).toMatch(/nothing was replaced/);
    expect(listIntegrationEvents(db, { limit: 1 })[0]?.outcome).toBe('FAILURE');
  });

  it('refuses repeated post cursors during a posts walk', async () => {
    const provider = new MockBufferReadProvider();
    provider.listPosts.mockResolvedValue({
      posts: [
        { id: 'p1', text: 'a', status: 'scheduled', dueAt: null, channelId: 'c1' } as BufferPost,
      ],
      hasNextPage: true,
      endCursor: 'same',
    } satisfies BufferPostsPage);
    const service = new BufferAccountsService(db, provider);
    await expect(service.readAllPosts('org-1')).rejects.toThrow(/repeated or omitted/);
  });

  it('returns the stored snapshot when the provider is unavailable', async () => {
    const { UnavailableBufferReadProvider } = await import('./buffer/read-provider.ts');
    const service = new BufferAccountsService(db, new UnavailableBufferReadProvider(), clock);
    const result = await service.refresh();
    expect(result.channels).toEqual([]);
    expect(result.reason).toMatch(/BUFFER_API_KEY/);
  });

  it('keeps the prior generation when rate limiting is still active', async () => {
    const provider = new MockBufferReadProvider();
    const service = new BufferAccountsService(db, provider, clock);
    await service.refresh();
    const { recordSyncHealth } = await import('./sync-health.ts');
    recordSyncHealth(db, { rateLimitedUntil: '2099-01-01T00:00:00.000Z' });
    provider.account.mockClear();
    const limited = await service.refresh();
    expect(limited.channels).toHaveLength(3);
    expect(limited.reason).toMatch(/rate-limiting/);
    expect(provider.account).not.toHaveBeenCalled();
  });

  it('records rate-limit health when Buffer refuses with a retry hint', async () => {
    const provider = new MockBufferReadProvider();
    const service = new BufferAccountsService(db, provider, clock);
    const { BufferProviderError } = await import('./buffer/error.ts');
    provider.account.mockRejectedValueOnce(
      new BufferProviderError('too many', { rateLimited: true, retryAfterSeconds: 30 }),
    );
    await service.refresh();
    const { readSyncHealth } = await import('./sync-health.ts');
    expect(readSyncHealth(db)?.rateLimitedUntil).toBe('2030-01-02T00:00:30.000Z');
    expect(listIntegrationEvents(db, { limit: 1 })[0]?.outcome).toBe('FAILURE');
  });

  it('refuses when pagination exceeds the safety bound', async () => {
    const provider = new MockBufferReadProvider();
    const { BUFFER_POSTS_PAGE_MAX } = await import('../../shared/buffer.ts');
    let cursor = 0;
    provider.listPosts.mockImplementation(async () => {
      cursor += 1;
      return {
        posts: [
          {
            id: `p${cursor}`,
            text: 'a',
            status: 'scheduled',
            dueAt: null,
            channelId: 'c1',
          } as BufferPost,
        ],
        hasNextPage: true,
        endCursor: `cursor-${cursor}`,
      };
    });
    const service = new BufferAccountsService(db, provider);
    await expect(service.readAllPosts('org-1')).rejects.toThrow(
      new RegExp(`${BUFFER_POSTS_PAGE_MAX}-page safety bound`),
    );
  });

  it('stores unknown services and drops channels Buffer no longer lists', async () => {
    const provider = new MockBufferReadProvider();
    provider.channelRows.push({
      id: 'ch-unknown',
      name: '@legacy',
      service: 'twitter',
      isDisconnected: false,
      isLocked: false,
      isQueuePaused: false,
    });
    const service = new BufferAccountsService(db, provider, clock);
    await service.refresh();
    expect(service.read().channels).toHaveLength(4);
    expect(service.selectableTargets()).toHaveLength(2);
    expect(
      service.read().channels.find((channel) => channel.channelId === 'ch-unknown')?.unavailable,
    ).toBe('Unknown Buffer service');

    provider.channelRows = provider.channelRows.filter((channel) => channel.id !== 'ch-youtube');
    await service.refresh();
    expect(
      service
        .read()
        .channels.map((channel) => channel.channelId)
        .sort(),
    ).toEqual(['ch-paused', 'ch-tiktok', 'ch-unknown']);
  });

  it('ignores corrupt stored account metadata before refreshing', async () => {
    const { setSetting } = await import('../drive/service.ts');
    const { BUFFER_ACCOUNTS_KEY } = await import('./buffer-accounts.ts');
    setSetting(db, BUFFER_ACCOUNTS_KEY, '{not-json');
    const provider = new MockBufferReadProvider();
    const service = new BufferAccountsService(db, provider, clock);
    await service.refresh();
    expect(service.read().lastRefreshAt).toBe(NOW.toISOString());
  });

  it('maps stored channels to publish targets and drops unknown platforms', async () => {
    const provider = new MockBufferReadProvider();
    const service = new BufferAccountsService(db, provider, clock);
    await service.refresh();
    const targets = bufferTargetsFromDb(db);
    expect(targets.map((target) => target.platform).sort()).toEqual([
      'tiktok',
      'youtube',
      'youtube',
    ]);
    expect(service.selectableTargets()).toHaveLength(2);
    expect(service.read().organizationId).toBe('org-1');
  });

  it('uses the default clock when none is supplied', async () => {
    const provider = new MockBufferReadProvider();
    const service = new BufferAccountsService(db, provider);
    const refreshed = await service.refresh();
    expect(refreshed.lastRefreshAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('resolveBufferOrganizationId', () => {
  it('refuses when Buffer returns no organizations', () => {
    expect(() => resolveBufferOrganizationId([])).toThrow(/no organizations/);
  });

  it('refuses when the configured organization id is absent from the account', () => {
    expect(() => resolveBufferOrganizationId([{ id: 'a' }], 'missing')).toThrow(
      /BUFFER_ORGANIZATION_ID/,
    );
  });
});

describe('buffer account routes', () => {
  it('reads stored channels without contacting Buffer', async () => {
    const provider = new MockBufferReadProvider();
    const app = createApp(db, {
      bufferRead: provider,
      publish: new MockPublishProvider(),
      publishTimezone: 'America/New_York',
    });
    await request(app).post('/api/signal/buffer-accounts/refresh').expect(200);
    provider.account.mockClear();
    provider.channels.mockClear();
    const response = await request(app).get('/api/signal/buffer-accounts').expect(200);
    expect(response.body.channels).toHaveLength(3);
    expect(provider.account).not.toHaveBeenCalled();
    expect(provider.channels).not.toHaveBeenCalled();
  });
});

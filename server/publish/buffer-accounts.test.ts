import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from '../db.ts';
import { createApp } from '../app.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import type { BufferChannel, BufferPost, BufferPostsPage, BufferReadProvider } from './buffer/read-provider.ts';
import { BufferAccountsService } from './buffer-accounts.ts';
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
      posts: [{ id: 'p1', text: 'a', status: 'scheduled', dueAt: null, channelId: 'c1' } as BufferPost],
      hasNextPage: true,
      endCursor: 'same',
    } satisfies BufferPostsPage);
    const service = new BufferAccountsService(db, provider);
    await expect(service.readAllPosts('org-1')).rejects.toThrow(/repeated or omitted/);
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

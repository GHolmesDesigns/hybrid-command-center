import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb } from '../db.ts';
import { createApp } from '../app.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { MockPublishProvider } from './mock-provider.ts';
import { BufferAccountsService } from './buffer-accounts.ts';
import { PublishProviderError } from './provider.ts';
import { resolvePublishingTargets } from './targets.ts';

describe('resolvePublishingTargets', () => {
  const clock = () => new Date('2030-01-01T00:00:00.000Z');

  const bufferProvider = {
    available: true,
    async account() {
      return { id: 'a', organizations: [{ id: 'org', name: 'Org' }] };
    },
    async channels() {
      return [
        {
          id: 'buf-tt',
          name: '@tt',
          service: 'tiktok',
          isDisconnected: false,
          isLocked: false,
          isQueuePaused: false,
        },
      ];
    },
    async listPosts() {
      return { posts: [], hasNextPage: false, endCursor: null };
    },
  };

  it('merges Post Bridge listings with stored Buffer channels when both are available', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    const buffer = new BufferAccountsService(db, bufferProvider, clock);
    const targets = await resolvePublishingTargets(db, publish, buffer, clock);
    expect(targets.map((target) => target.platform).sort()).toEqual(['tiktok', 'twitter']);
  });

  it('skips Buffer when the read provider is unavailable', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    const buffer = new BufferAccountsService(db, {
      available: false,
      async account() {
        throw new Error('Buffer needs BUFFER_API_KEY.');
      },
      async channels() {
        throw new Error('Buffer needs BUFFER_API_KEY.');
      },
      async listPosts() {
        throw new Error('Buffer needs BUFFER_API_KEY.');
      },
    });
    const targets = await resolvePublishingTargets(db, publish, buffer, clock);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.platform).toBe('twitter');
  });

  it('keeps Buffer accounts when a cold Post Bridge listing fails on the same press', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    publish.listTargets = async () => {
      throw new PublishProviderError('Post Bridge refused the request (503).', true);
    };
    const buffer = new BufferAccountsService(db, bufferProvider, clock);
    const targets = await resolvePublishingTargets(db, publish, buffer, clock);
    expect(targets).toEqual([
      expect.objectContaining({ platform: 'tiktok', provider: 'buffer', handle: '@tt' }),
    ]);
  });

  it('surfaces a Post Bridge listing failure when Buffer contributes nothing', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    publish.listTargets = async () => {
      throw new PublishProviderError('Post Bridge refused the request (503).', true);
    };
    const buffer = new BufferAccountsService(db, {
      available: false,
      async account() {
        throw new Error('off');
      },
      async channels() {
        throw new Error('off');
      },
      async listPosts() {
        throw new Error('off');
      },
    });
    await expect(resolvePublishingTargets(db, publish, buffer, clock)).rejects.toThrow(
      /Post Bridge refused/,
    );
  });

  it('loads Post Bridge and Buffer in parallel without a duplicate Buffer refresh', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    let channelCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buffer = new BufferAccountsService(
      db,
      {
        available: true,
        async account() {
          return { id: 'a', organizations: [{ id: 'org', name: 'Org' }] };
        },
        async channels() {
          channelCalls += 1;
          await gate;
          return [
            {
              id: 'buf-tt',
              name: '@tt',
              service: 'tiktok',
              isDisconnected: false,
              isLocked: false,
              isQueuePaused: false,
            },
          ];
        },
        async listPosts() {
          return { posts: [], hasNextPage: false, endCursor: null };
        },
      },
      clock,
    );

    const first = resolvePublishingTargets(db, publish, buffer, clock);
    const second = resolvePublishingTargets(db, publish, buffer, clock);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(channelCalls).toBe(1);
    expect(a.map((target) => target.platform).sort()).toEqual(['tiktok', 'twitter']);
    expect(b.map((target) => target.platform).sort()).toEqual(['tiktok', 'twitter']);
  });
});

describe('cold publish preview over HTTP', () => {
  const clock = () => new Date('2030-01-01T00:00:00.000Z');

  it('returns the same Buffer preview on the first and second press when Post Bridge listing fails', async () => {
    const db = createDb(':memory:');
    const post = seedSignalPost(db, {
      text: 'Cold preview post',
      channels: ['tt'],
      date: '2030-02-01',
      time: '09:00',
      status: 'SCHEDULED',
    });
    let listCalls = 0;
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    publish.listTargets = async () => {
      listCalls += 1;
      throw new PublishProviderError('Post Bridge refused the request (503).', true);
    };
    const app = createApp(db, {
      publish,
      publishTimezone: 'America/New_York',
      now: clock,
      bufferRead: {
        available: true,
        async account() {
          return { id: 'a', organizations: [{ id: 'org', name: 'Org' }] };
        },
        async channels() {
          return [
            {
              id: 'buf-tt',
              name: '@tt',
              service: 'tiktok',
              isDisconnected: false,
              isLocked: false,
              isQueuePaused: false,
            },
          ];
        },
        async listPosts() {
          return { posts: [], hasNextPage: false, endCursor: null };
        },
      },
    });

    const first = await request(app).post(`/api/signal/posts/${post.id}/publish/preview`).send({});
    expect(first.status).toBe(200);
    expect(first.body.connectedAccounts).toEqual([
      expect.objectContaining({ provider: 'buffer', platform: 'tiktok', handle: '@tt' }),
    ]);
    expect(first.body.channels[0]?.provider).toBe('buffer');

    const second = await request(app).post(`/api/signal/posts/${post.id}/publish/preview`).send({});
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(listCalls).toBe(2);
  });
});

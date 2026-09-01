import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb } from '../db.ts';
import { createApp } from '../app.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { MockPublishProvider } from './mock-provider.ts';
import { BufferAccountsService } from './buffer-accounts.ts';
import { PublishProviderError, UnavailablePublishProvider } from './provider.ts';
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

  it('keeps current TikTok and YouTube routing on Post Bridge', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    const buffer = new BufferAccountsService(db, bufferProvider, clock);
    const targets = await resolvePublishingTargets(db, publish, buffer, clock);
    expect(targets.map((target) => target.platform).sort()).toEqual(['twitter']);
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

  it('refreshes historical Buffer accounts without offering them when Post Bridge is unavailable', async () => {
    const db = createDb(':memory:');
    let channelCalls = 0;
    const buffer = new BufferAccountsService(
      db,
      {
        ...bufferProvider,
        async channels() {
          channelCalls += 1;
          return bufferProvider.channels();
        },
      },
      clock,
    );

    const targets = await resolvePublishingTargets(
      db,
      new UnavailablePublishProvider(),
      buffer,
      clock,
    );

    expect(channelCalls).toBe(1);
    expect(targets).toEqual([]);
    expect(buffer.selectableTargets()).toEqual([]);
  });

  it('does not use Buffer as a fallback when Post Bridge listing fails', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    publish.listTargets = async () => {
      throw new PublishProviderError('Post Bridge refused the request (503).', true);
    };
    const buffer = new BufferAccountsService(db, bufferProvider, clock);
    await expect(resolvePublishingTargets(db, publish, buffer, clock)).rejects.toThrow(
      /Post Bridge refused/,
    );
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
    expect(a.map((target) => target.platform).sort()).toEqual(['twitter']);
    expect(b.map((target) => target.platform).sort()).toEqual(['twitter']);
  });
});

describe('cold publish preview over HTTP', () => {
  const clock = () => new Date('2030-01-01T00:00:00.000Z');

  it('refuses a cold TikTok preview when Post Bridge listing fails', async () => {
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

    const response = await request(app)
      .post(`/api/signal/posts/${post.id}/publish/preview`)
      .send({});
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Something went wrong on the server.');
    expect(listCalls).toBe(1);
  });
});

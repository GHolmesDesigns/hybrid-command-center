import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../db.ts';
import { MockPublishProvider } from './mock-provider.ts';
import { BufferAccountsService } from './buffer-accounts.ts';
import { UnavailableBufferReadProvider } from './buffer/read-provider.ts';
import { resolvePublishingTargets } from './targets.ts';

vi.mock('../config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.ts')>();
  return { ...actual, bufferConfigured: () => true };
});

describe('resolvePublishingTargets', () => {
  it('merges Post Bridge listings with stored Buffer channels when both are available', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    const buffer = new BufferAccountsService(
      db,
      {
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
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    await buffer.refresh();
    const targets = await resolvePublishingTargets(
      db,
      publish,
      buffer,
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(targets.map((target) => target.platform).sort()).toEqual(['tiktok', 'twitter']);
  });

  it('skips Buffer when the read provider is unavailable', async () => {
    const db = createDb(':memory:');
    const publish = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@x', name: 'X' },
    ]);
    const buffer = new BufferAccountsService(db, new UnavailableBufferReadProvider());
    const targets = await resolvePublishingTargets(
      db,
      publish,
      buffer,
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]?.platform).toBe('twitter');
  });
});

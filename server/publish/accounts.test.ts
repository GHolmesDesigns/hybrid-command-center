import { describe, expect, it } from 'vitest';
import { backfillProviderAccounts, createDb } from '../db.ts';
import {
  POST_BRIDGE_PROVIDER,
  providerAccountByIdentity,
  providerAccountsByIds,
  resolveProviderAccounts,
} from './accounts.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { targetRowsFor } from './read.ts';
import { toTarget } from './rows.ts';
import { readProviderInventoryPosts } from './inventory-rows.ts';

describe('provider-neutral account identities', () => {
  it('round-trips an opaque Buffer channel id without numeric coercion', () => {
    const db = createDb(':memory:');
    const ref = 'youtube:UC_01-opaque/Channel';
    const [resolved] = resolveProviderAccounts(
      db,
      [
        {
          id: 0,
          provider: 'buffer',
          accountRef: ref,
          platform: 'youtube',
          handle: '@studio',
          name: 'Studio',
        },
      ],
      () => new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(resolved?.accountRef).toBe(ref);
    expect(providerAccountByIdentity(db, 'buffer', ref)).toMatchObject({
      id: resolved?.id,
      provider: 'buffer',
      accountRef: ref,
      platform: 'youtube',
    });
  });

  it('keeps equal-looking references under different providers separate', () => {
    const db = createDb(':memory:');
    const rows = resolveProviderAccounts(db, [
      { id: 41, platform: 'tiktok', handle: '@pb', name: 'PB' },
      {
        id: 41,
        provider: 'buffer',
        accountRef: '41',
        platform: 'tiktok',
        handle: '@buffer',
        name: 'Buffer',
      },
    ]);
    expect(rows[0]?.provider).toBe(POST_BRIDGE_PROVIDER);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
    expect(providerAccountByIdentity(db, POST_BRIDGE_PROVIDER, '41')?.id).toBe(rows[0]?.id);
    expect(providerAccountByIdentity(db, 'buffer', '41')?.id).toBe(rows[1]?.id);
  });

  it('refreshes display metadata without changing the durable identity', () => {
    const db = createDb(':memory:');
    const first = resolveProviderAccounts(db, [
      { id: 7, platform: 'facebook', handle: '@old', name: 'Old' },
    ])[0];
    const second = resolveProviderAccounts(db, [
      { id: 7, platform: 'facebook', handle: '@new', name: 'New' },
    ])[0];
    expect(second?.id).toBe(first?.id);
    expect(providerAccountByIdentity(db, POST_BRIDGE_PROVIDER, '7')).toMatchObject({
      handle: '@new',
      name: 'New',
    });
  });

  it('reads local surrogates in caller order and omits unknown ids', () => {
    const db = createDb(':memory:');
    const [first, second] = resolveProviderAccounts(db, [
      { id: 7, platform: 'facebook', handle: '@first', name: 'First' },
      { id: 8, platform: 'instagram', handle: '@second', name: 'Second' },
    ]);
    expect(providerAccountsByIds(db, [second!.id, 999_999, first!.id])).toEqual([
      expect.objectContaining({ id: second!.id, accountRef: '8' }),
      expect.objectContaining({ id: first!.id, accountRef: '7' }),
    ]);
  });

  it('backfills legacy rows deterministically and is idempotent', () => {
    const db = createDb(':memory:');
    db.prepare(
      `INSERT INTO signal_posts(id,text,status,position,created_at,updated_at)
       VALUES('post','Copy','PLANNED',0,'2029-01-01T00:00:00.000Z','2029-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO signal_post_publish_targets(post_id,channel,provider_account_id,created_at)
       VALUES('post','yt',9001,'2029-01-01T00:00:00.000Z')`,
    ).run();
    expect(backfillProviderAccounts(db)).toBe(1);
    expect(backfillProviderAccounts(db)).toBe(0);
    expect(providerAccountByIdentity(db, POST_BRIDGE_PROVIDER, '9001')).toMatchObject({
      id: 9001,
      platform: 'youtube',
    });
  });

  it('round-trips an opaque remote post id on one Buffer target with no parent post id', () => {
    const db = createDb(':memory:');
    const account = resolveProviderAccounts(db, [
      {
        id: 0,
        provider: 'buffer',
        accountRef: 'channel:opaque',
        platform: 'youtube',
        handle: '@studio',
        name: 'Studio',
      },
    ])[0];
    const post = seedSignalPost(db);
    db.prepare(
      `INSERT INTO signal_publications(
         id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
         sent_caption,sent_channels,created_at,updated_at
       ) VALUES('buffer-pub',?,'SUBMITTED','buffer',NULL,'key','2030-01-02T00:00:00.000Z',
                'America/New_York','Copy','["yt"]','2030-01-01T00:00:00.000Z',
                '2030-01-01T00:00:00.000Z')`,
    ).run(post.id);
    db.prepare(
      `INSERT INTO signal_publication_targets(
         publication_id,channel,provider_account_id,handle,mode,remote_post_id
       ) VALUES('buffer-pub','yt',?,'@studio','AUTOMATIC',?)`,
    ).run(account?.id, 'post/opaque:01-ABC');
    expect(toTarget(targetRowsFor(db, 'buffer-pub')[0]!, 'buffer')).toMatchObject({
      provider: 'buffer',
      accountRef: 'channel:opaque',
      remotePostId: 'post/opaque:01-ABC',
    });
  });

  it('keeps equal remote post ids in separate provider inventory partitions', () => {
    const db = createDb(':memory:');
    const insert = db.prepare(
      `INSERT INTO signal_provider_inventory_posts(
         provider,provider_post_id,state,caption_excerpt,account_refs,snapshot_at
       ) VALUES(?,?,'SCHEDULED','Copy','[]','2030-01-01T00:00:00.000Z')`,
    );
    insert.run('post-bridge', 'same-id');
    insert.run('buffer', 'same-id');
    expect(readProviderInventoryPosts(db, 'post-bridge')[0]?.provider).toBe('post-bridge');
    expect(readProviderInventoryPosts(db, 'buffer')[0]?.provider).toBe('buffer');
  });

  it('rolls back a conflicting partial migration and refuses startup use', () => {
    const db = createDb(':memory:');
    db.prepare(
      `INSERT INTO signal_provider_accounts(
         id,provider,provider_account_ref,platform,resolved_at,created_at,updated_at
       ) VALUES(55,'buffer','opaque','tiktok','x','x','x')`,
    ).run();
    const post = seedSignalPost(db);
    db.prepare(
      `INSERT INTO signal_post_publish_targets(post_id,channel,provider_account_id,created_at)
       VALUES(?,'tt',55,'x')`,
    ).run(post.id);
    expect(() => backfillProviderAccounts(db)).toThrow(/already names another identity/);
    expect(
      db.prepare('SELECT provider,provider_account_ref FROM signal_provider_accounts').all(),
    ).toEqual([{ provider: 'buffer', provider_account_ref: 'opaque' }]);
  });

  it('keeps account history delete-restricted', () => {
    const db = createDb(':memory:');
    const account = resolveProviderAccounts(db, [
      { id: 81, platform: 'instagram', handle: '@studio', name: 'Studio' },
    ])[0];
    const post = seedSignalPost(db);
    db.prepare(
      `INSERT INTO signal_post_publish_targets(post_id,channel,provider_account_id,created_at)
       VALUES(?,'ig',?,'x')`,
    ).run(post.id, account?.id);
    expect(() =>
      db.prepare('DELETE FROM signal_provider_accounts WHERE id=?').run(account?.id),
    ).toThrow(/referenced account history cannot be deleted/);
  });
});

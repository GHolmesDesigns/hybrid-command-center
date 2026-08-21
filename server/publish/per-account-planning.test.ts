import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { buildPublishPlan } from './plan.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { getPost } from '../signal/service.ts';
import type { PublishTarget } from './provider.ts';
import type { PublishTargetSelections } from '../../shared/publish.ts';
import type { SignalPost } from '../../shared/signal.ts';
import type { PublishVariantRecord } from '../../shared/publish-variants.ts';

/**
 * Planning one channel to several explicitly chosen accounts (C77, piece 3).
 *
 * Two claims, and they pull in opposite directions, which is why both are pinned here.
 *
 * 1. **A post nobody has selected for plans exactly as it always did** — same report, same plan
 *    hash, no `targets` list at all. Absent rather than empty: the difference between "nobody
 *    chose" and "chose nothing" is the whole additive guarantee.
 * 2. **A selection replaces §3.1's rule rather than filtering it.** Two Facebook pages become two
 *    target reports with their own verdicts, and "resolved to 3 accounts" stops being a refusal
 *    because somebody said which ones.
 */

const FB_GHD = 85300;
const FB_WILD = 85301;
const FB_ADDRIVE = 85299;
const IG = 85292;

const CONNECTED: PublishTarget[] = [
  { id: FB_GHD, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: FB_WILD, platform: 'facebook', handle: 'wildeyephoto', name: 'Wild Eye Photography' },
  { id: FB_ADDRIVE, platform: 'facebook', handle: 'addrivemedia', name: 'AdDrive Media' },
  { id: IG, platform: 'instagram', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
];

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const NOW = new Date('2027-08-01T00:00:00.000Z');

const plan = (
  post: SignalPost,
  selections: PublishTargetSelections = [],
  variants: PublishVariantRecord[] = [],
  connected: PublishTarget[] = CONNECTED,
) => buildPublishPlan(post, connected, 'America/New_York', NOW, variants, selections);

const seed = (channels: SignalPost['channels']) =>
  getPost(db, seedSignalPost(db, { channels }).id) as SignalPost;

const fb = (report: ReturnType<typeof plan>) =>
  report.channels.find((entry) => entry.channel === 'fb');

describe('no selection plans exactly as before', () => {
  it('carries no targets list at all', () => {
    const report = fb(plan(seed(['fb'])));
    expect(report?.targets).toBeUndefined();
    expect(report?.accountId).toBe(FB_GHD);
  });

  it('leaves the plan hash where it was', () => {
    const post = seed(['fb']);
    expect(plan(post, []).planHash).toBe(plan(post).planHash);
  });

  it('still refuses Facebook when three pages are connected and none was chosen', () => {
    // §3.1's rule is untouched where nobody selected: G.Holmes Designs is matched by name.
    const report = fb(plan(seed(['fb'])));
    expect(report?.status).toBe('READY');
    expect(report?.accountId).toBe(FB_GHD);
  });
});

describe('an explicit selection', () => {
  it('names every chosen account, in the order it was given', () => {
    const post = seed(['fb']);
    const report = fb(
      plan(post, [
        { channel: 'fb', providerAccountId: FB_GHD },
        { channel: 'fb', providerAccountId: FB_WILD },
      ]),
    );
    expect(report?.targets?.map((entry) => entry.accountId)).toEqual([FB_GHD, FB_WILD]);
    expect(report?.targets?.map((entry) => entry.handle)).toEqual([
      'gholmesdesigns',
      'wildeyephoto',
    ]);
  });

  it('replaces the one-account rule rather than filtering it', () => {
    // AdDrive Media is neither the §3.1 page nor matched by handle. Choosing it explicitly is
    // enough, because the rule it used to break is the rule a selection replaces.
    const report = fb(plan(seed(['fb']), [{ channel: 'fb', providerAccountId: FB_ADDRIVE }]));
    expect(report?.status).toBe('READY');
    expect(report?.targets?.map((entry) => entry.accountId)).toEqual([FB_ADDRIVE]);
  });

  it('puts both accounts on the plan-level target list, so both would be sent to', () => {
    const preview = plan(seed(['fb']), [
      { channel: 'fb', providerAccountId: FB_GHD },
      { channel: 'fb', providerAccountId: FB_WILD },
    ]);
    expect(preview.targets.map((target) => target.accountId)).toEqual([FB_GHD, FB_WILD]);
    expect(preview.request?.targets).toEqual([
      { accountId: FB_GHD, platform: 'facebook' },
      { accountId: FB_WILD, platform: 'facebook' },
    ]);
  });

  it('describes the first chosen account at channel level, for a reader that predates the list', () => {
    const report = fb(
      plan(seed(['fb']), [
        { channel: 'fb', providerAccountId: FB_WILD },
        { channel: 'fb', providerAccountId: FB_GHD },
      ]),
    );
    expect(report?.accountId).toBe(FB_WILD);
    expect(report?.handle).toBe('wildeyephoto');
  });
});

describe('a stale selection', () => {
  it('refuses by naming the account, not the platform', () => {
    const withoutWild = CONNECTED.filter((target) => target.id !== FB_WILD);
    const report = fb(
      plan(
        seed(['fb']),
        [
          { channel: 'fb', providerAccountId: FB_GHD },
          { channel: 'fb', providerAccountId: FB_WILD },
        ],
        [],
        withoutWild,
      ),
    );
    expect(report?.status).toBe('BLOCKED');
    expect(report?.refusals.join(' ')).toContain(String(FB_WILD));
    // The account that is still connected is still reported, rather than being lost inside a
    // platform-level sentence about the channel being broken.
    expect(report?.targets?.map((entry) => entry.accountId)).toEqual([FB_GHD]);
  });

  it('blocks the channel when one chosen account is unusable, rather than sending to the rest', () => {
    const withoutWild = CONNECTED.filter((target) => target.id !== FB_WILD);
    const preview = plan(
      seed(['fb']),
      [
        { channel: 'fb', providerAccountId: FB_GHD },
        { channel: 'fb', providerAccountId: FB_WILD },
      ],
      [],
      withoutWild,
    );
    expect(preview.targets).toEqual([]);
    expect(preview.request).toBeUndefined();
  });
});

describe('the plan hash', () => {
  it('changes when a target is added', () => {
    const post = seed(['fb']);
    const one = plan(post, [{ channel: 'fb', providerAccountId: FB_GHD }]).planHash;
    const two = plan(post, [
      { channel: 'fb', providerAccountId: FB_GHD },
      { channel: 'fb', providerAccountId: FB_WILD },
    ]).planHash;
    expect(two).not.toBe(one);
  });

  it('changes when a chosen account is swapped for another', () => {
    const post = seed(['fb']);
    expect(plan(post, [{ channel: 'fb', providerAccountId: FB_WILD }]).planHash).not.toBe(
      plan(post, [{ channel: 'fb', providerAccountId: FB_GHD }]).planHash,
    );
  });

  it('changes when an account variant is edited under an unchanged selection', () => {
    const post = seed(['fb']);
    const selection: PublishTargetSelections = [{ channel: 'fb', providerAccountId: FB_GHD }];
    const before = plan(post, selection).planHash;
    const after = plan(post, selection, [
      { platform: 'facebook', accountId: FB_GHD, caption: 'Just this page', updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]).planHash;
    expect(after).not.toBe(before);
  });
});

describe('a channel with no selection, beside one with', () => {
  it('keeps its own shape while the other gains a list', () => {
    const preview = plan(seed(['fb', 'ig']), [
      { channel: 'fb', providerAccountId: FB_GHD },
      { channel: 'fb', providerAccountId: FB_WILD },
    ]);
    expect(preview.channels.find((entry) => entry.channel === 'ig')?.targets).toBeUndefined();
    expect(preview.channels.find((entry) => entry.channel === 'fb')?.targets).toHaveLength(2);
  });
});

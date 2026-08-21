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
const BSKY = 85298;

const CONNECTED: PublishTarget[] = [
  { id: FB_GHD, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: FB_WILD, platform: 'facebook', handle: 'wildeyephoto', name: 'Wild Eye Photography' },
  { id: FB_ADDRIVE, platform: 'facebook', handle: 'addrivemedia', name: 'AdDrive Media' },
  { id: IG, platform: 'instagram', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: BSKY, platform: 'bluesky', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
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
    // Tailored apart, because the same-platform rule below refuses two pages given the same
    // content and this case is about the target list rather than about that refusal.
    const preview = plan(
      seed(['fb']),
      [
        { channel: 'fb', providerAccountId: FB_GHD },
        { channel: 'fb', providerAccountId: FB_WILD },
      ],
      [
        { platform: 'facebook', accountId: FB_GHD, caption: 'For the studio', updatedAt: 'x' },
        { platform: 'facebook', accountId: FB_WILD, caption: 'For the gallery', updatedAt: 'x' },
      ] as unknown as PublishVariantRecord[],
    );
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

describe('the same-platform policy rule', () => {
  const bothPages: PublishTargetSelections = [
    { channel: 'fb', providerAccountId: FB_GHD },
    { channel: 'fb', providerAccountId: FB_WILD },
  ];

  it('refuses two accounts given the post’s own untailored content', () => {
    // Nothing is tailored, so both pages resolve the same caption. The provider would take it;
    // §14 recorded that it raises no duplicate-content refusal of its own.
    const report = fb(plan(seed(['fb']), bothPages));
    expect(report?.status).toBe('BLOCKED');
    expect(report?.refusals.join(' ')).toContain('gholmesdesigns and wildeyephoto');
  });

  it('allows two accounts once each has its own caption', () => {
    const report = fb(
      plan(seed(['fb']), bothPages, [
        { platform: 'facebook', accountId: FB_GHD, caption: 'For the studio', updatedAt: 'x' },
        { platform: 'facebook', accountId: FB_WILD, caption: 'For the gallery', updatedAt: 'x' },
      ] as unknown as PublishVariantRecord[]),
    );
    expect(report?.refusals).toEqual([]);
    expect(report?.status).toBe('READY');
  });

  it('still refuses when only one of the two was tailored', () => {
    const report = fb(
      plan(seed(['fb']), bothPages, [
        { platform: 'facebook', accountId: FB_GHD, caption: 'For the studio', updatedAt: 'x' },
      ] as unknown as PublishVariantRecord[]),
    );
    // One account moved, the other still carries the post's own caption — they are distinct now.
    expect(report?.status).toBe('READY');
  });

  it('never fires for a single account, however many are connected', () => {
    const report = fb(plan(seed(['fb']), [{ channel: 'fb', providerAccountId: FB_GHD }]));
    expect(report?.refusals).toEqual([]);
  });

  it('never fires where nobody selected, so an untouched post is untouched', () => {
    expect(fb(plan(seed(['fb'])))?.refusals).toEqual([]);
  });

  it('builds no request while the collision stands', () => {
    expect(plan(seed(['fb']), bothPages).request).toBeUndefined();
  });
});

describe('two accounts, distinct content, one request (C77 acceptance)', () => {
  const bothPages: PublishTargetSelections = [
    { channel: 'fb', providerAccountId: FB_GHD },
    { channel: 'fb', providerAccountId: FB_WILD },
  ];
  const tailored = [
    { platform: 'facebook', accountId: FB_GHD, caption: 'For the studio', updatedAt: 'x' },
    { platform: 'facebook', accountId: FB_WILD, caption: 'For the gallery', updatedAt: 'x' },
  ] as unknown as PublishVariantRecord[];

  it('sends one request naming both accounts, each with its own caption', () => {
    const preview = plan(seed(['fb']), bothPages, tailored);
    expect(preview.request?.targets).toHaveLength(2);
    expect(preview.request?.accountConfigurations).toEqual([
      { accountId: FB_GHD, caption: 'For the studio' },
      { accountId: FB_WILD, caption: 'For the gallery' },
    ]);
  });

  it('omits an account whose caption is the post’s own, rather than repeating it', () => {
    const preview = plan(seed(['fb']), bothPages, [
      { platform: 'facebook', accountId: FB_GHD, caption: 'For the studio', updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]);
    // Wild Eye resolves the post's own caption, so it needs no configuration of its own — the
    // submission's caption already says it.
    expect(preview.request?.accountConfigurations).toEqual([
      { accountId: FB_GHD, caption: 'For the studio' },
    ]);
  });

  it('carries no accountConfigurations key at all where nobody selected', () => {
    expect(plan(seed(['fb'])).request).not.toHaveProperty('accountConfigurations');
  });

  it('emits nothing per account for a platform the evidence does not cover', () => {
    // Bluesky's accountContentOverride is false: no §14 result names it, and unverified is not
    // the same as unsupported. An account layer there still travels as the platform's. Bluesky
    // rather than Instagram because Instagram refuses a post carrying no media, and a blocked
    // plan builds no request at all -- which would pass this assertion for the wrong reason.
    const preview = plan(seed(['bsky']), [{ channel: 'bsky', providerAccountId: BSKY }], [
      { platform: 'bluesky', accountId: BSKY, caption: 'Just this account', updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]);
    expect(preview.request).toBeDefined();
    expect(preview.request).not.toHaveProperty('accountConfigurations');
  });
});

describe('fields that stay platform-level even where accounts are carried', () => {
  it('warns that an account’s first comment reaches every account on the platform', () => {
    const report = fb(
      plan(seed(['fb']), [{ channel: 'fb', providerAccountId: FB_GHD }], [
        {
          platform: 'facebook',
          accountId: FB_GHD,
          firstComment: 'account-only tags',
          updatedAt: 'x',
        },
      ] as unknown as PublishVariantRecord[]),
    );
    expect(report?.warnings.join(' ')).toMatch(/not first comment/i);
    expect(report?.warnings.join(' ')).toMatch(/reaches every account/i);
  });

  it('does not warn about a caption, which this provider does carry per account', () => {
    const report = fb(
      plan(seed(['fb']), [{ channel: 'fb', providerAccountId: FB_GHD }], [
        { platform: 'facebook', accountId: FB_GHD, caption: 'Just this page', updatedAt: 'x' },
      ] as unknown as PublishVariantRecord[]),
    );
    expect(report?.warnings.join(' ')).not.toMatch(/reaches every account/i);
  });

  it('still gives the old platform-level warning where the flag is false', () => {
    const report = plan(seed(['ig']), [{ channel: 'ig', providerAccountId: IG }], [
      { platform: 'instagram', accountId: IG, caption: 'Just this account', updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]).channels.find((entry) => entry.channel === 'ig');
    expect(report?.warnings.join(' ')).toMatch(/one set of content per platform/i);
  });
});

describe('media an account chose for itself', () => {
  const bothPages: PublishTargetSelections = [
    { channel: 'fb', providerAccountId: FB_GHD },
    { channel: 'fb', providerAccountId: FB_WILD },
  ];
  const DRIVE_A = 'https://drive.google.com/file/d/1AAA/view';
  const DRIVE_B = 'https://drive.google.com/file/d/1BBB/view';
  const PUBLIC = 'https://example.com/a.png';

  const driveItem = (url: string, name: string) =>
    ({
      source: 'DRIVE',
      url,
      driveFileId: name,
      driveName: `${name}.png`,
      mimeType: 'image/png',
      sizeBytes: 1024,
      driveVersion: '1',
      driveModifiedAt: '2027-01-01T00:00:00.000Z',
      driveChecksum: `sum-${name}`,
      driveVerifiedAt: '2027-01-01T00:00:00.000Z',
    }) as unknown as SignalPost['media'][number];

  const urlItem = (url: string) =>
    ({
      source: 'URL',
      url,
      driveFileId: null,
      driveName: null,
      mimeType: null,
      sizeBytes: null,
      driveVersion: null,
      driveModifiedAt: null,
      driveChecksum: null,
      driveVerifiedAt: null,
    }) as unknown as SignalPost['media'][number];

  const seedWithMedia = (media: SignalPost['media']) =>
    getPost(
      db,
      seedSignalPost(db, {
        channels: ['fb'],
        media,
        mediaUrls: media.map((item) => item.url),
      }).id,
    ) as SignalPost;

  it('sends one account its own Drive files, as ids the plan does not yet hold', () => {
    const post = seedWithMedia([driveItem(DRIVE_A, 'aaa'), driveItem(DRIVE_B, 'bbb')]);
    const preview = plan(post, bothPages, [
      { platform: 'facebook', accountId: FB_WILD, mediaUrls: [DRIVE_B], updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]);
    expect(preview.refusals).toEqual([]);
    // The plan names the account as having its own media and carries the files to upload; the ids
    // are empty because a provider media id is made immediately before the request, never planned.
    expect(preview.request?.accountConfigurations).toEqual([{ accountId: FB_WILD, mediaIds: [] }]);
    expect(
      (preview as { accountMediaSources?: { accountId: number; items: unknown[] }[] })
        .accountMediaSources,
    ).toEqual([{ accountId: FB_WILD, items: [expect.objectContaining({ url: DRIVE_B })] }]);
  });

  it('refuses a public address chosen for one account, and does not drop it', () => {
    const post = seedWithMedia([driveItem(DRIVE_A, 'aaa'), urlItem(PUBLIC)]);
    const preview = plan(post, bothPages, [
      { platform: 'facebook', accountId: FB_WILD, mediaUrls: [PUBLIC], updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]);
    const said = preview.refusals.join(' ') + preview.channels.flatMap((c) => c.refusals).join(' ');
    expect(said).toMatch(/only carries media per account as files uploaded from Drive/);
    expect(said).toContain('wildeyephoto');
    // Never silently replaced with the platform's media.
    expect(preview.request).toBeUndefined();
  });

  it('refuses per-account files on a post whose own media is public', () => {
    const post = seedWithMedia([urlItem(PUBLIC), driveItem(DRIVE_B, 'bbb')]);
    const preview = plan(post, bothPages, [
      { platform: 'facebook', accountId: FB_WILD, mediaUrls: [DRIVE_B], updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]);
    expect(preview.refusals.join(' ')).toMatch(/only sent as files uploaded from Drive/);
  });

  it('says nothing per account where every account keeps the channel’s media', () => {
    const post = seedWithMedia([driveItem(DRIVE_A, 'aaa')]);
    const preview = plan(post, bothPages, [
      { platform: 'facebook', accountId: FB_GHD, caption: 'For the studio', updatedAt: 'x' },
      { platform: 'facebook', accountId: FB_WILD, caption: 'For the gallery', updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]);
    expect(preview.request?.accountConfigurations?.every((entry) => !entry.mediaIds)).toBe(true);
  });

  it('moves the plan hash when an account’s own media changes', () => {
    const post = seedWithMedia([driveItem(DRIVE_A, 'aaa'), driveItem(DRIVE_B, 'bbb')]);
    const one = plan(post, bothPages, [
      { platform: 'facebook', accountId: FB_WILD, mediaUrls: [DRIVE_B], updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]).planHash;
    const two = plan(post, bothPages, [
      { platform: 'facebook', accountId: FB_WILD, mediaUrls: [DRIVE_A], updatedAt: 'x' },
    ] as unknown as PublishVariantRecord[]).planHash;
    expect(two).not.toBe(one);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { LocalSignalProvider } from '../signal/read.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { buildPublishPlan, preflightPlatform, publishInstantFor } from './plan.ts';
import { MockPublishProvider } from './mock-provider.ts';
import { PublishProviderError } from './provider.ts';
import { UnavailablePublishProvider } from './provider.ts';
import { PublishService } from './service.ts';
import {
  deliveryModeFor,
  deliveryModeForCapability,
  deliveryModeInstruction,
  deliveryModeNeedsPerson,
  deliveryTargetAwaitsPerson,
  deliveryTargetSummary,
  isReconcilableState,
  publishPreviewRefusals,
  publishPreviewWarnings,
  reconcileSchedule,
  DELIVERY_GROUP_LABEL,
  PUBLICATION_STATE_DESCRIPTION,
  PUBLICATION_STATE_GROUP,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATES,
  RECONCILE_INTERVALS_MINUTES,
  RECONCILE_MAX_ATTEMPTS,
  type DeliveryMode,
  type PublishChannelContent,
  type PublishChannelReport,
  type PublishPreview,
  type SignalPublication,
  type SignalPublicationTarget,
} from '../../shared/publish.ts';
import {
  resolvePublishContent,
  type PublishVariantBase,
  type PublishVariantRecord,
} from '../../shared/publish-variants.ts';
import { replacePostVariants } from '../signal/service.ts';
import { SIGNAL_CHANNELS, type SignalChannel, type SignalPost } from '../../shared/signal.ts';
import {
  publishPlatformFor,
  PUBLISH_CAPABILITIES,
  type PublishPlatformCapability,
} from '../../shared/publish-capabilities.ts';
import request from 'supertest';
import { createApp } from '../app.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';

let db: Db;
const targets = [
  { id: 1, platform: 'twitter', handle: '@gholmes', name: 'G.Holmes Designs' },
  { id: 2, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: 3, platform: 'facebook', handle: 'other', name: 'AdDrive Media' },
  { id: 4, platform: 'instagram', handle: '@gholmes', name: 'G.Holmes Designs' },
];
beforeEach(() => {
  db = createDb(':memory:');
});
const add = (overrides: Parameters<typeof seedSignalPost>[1] = {}) => seedSignalPost(db, overrides);
const reportFor = (plan: PublishPreview, channel: SignalChannel): PublishChannelReport =>
  plan.channels.find((report) => report.channel === channel) as PublishChannelReport;
/**
 * Resolved content for a preflight exercised on its own, so a case states only the field it is
 * about. Built through `resolvePublishContent` rather than by hand: a preflight test inventing its
 * own `sources` map would stop describing anything the plan actually produces.
 */
const resolvedContent = (
  overrides: Partial<PublishVariantBase> & { deliveryMode?: DeliveryMode } = {},
): PublishChannelContent => {
  const { deliveryMode = 'AUTOMATIC', ...base } = overrides;
  return {
    ...resolvePublishContent({
      caption: 'A clear campaign post',
      mediaUrls: [],
      postKind: 'POST',
      ...base,
    }),
    deliveryMode,
  };
};

describe('publishing time conversion', () => {
  it('refuses a daylight-saving gap and chooses the first repeated instant', () => {
    expect(() => publishInstantFor('2026-03-08', '02:30', 'America/New_York')).toThrow(
      /does not exist/,
    );
    expect(publishInstantFor('2026-11-01', '01:30', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });
});

describe('provider boundary', () => {
  it('names an unavailable provider consistently and keeps the shared states executable', async () => {
    const provider = new UnavailablePublishProvider('Publishing is off.');
    expect(PUBLICATION_STATES).toContain('UNCONFIRMED');
    await expect(provider.listTargets()).rejects.toThrow('Publishing is off.');
    await expect(
      provider.submit({
        caption: '',
        mediaUrls: [],
        scheduledInstant: '',
        timezone: '',
        targets: [],
      }),
    ).rejects.toThrow('Publishing is off.');
    await expect(provider.check('missing')).rejects.toThrow('Publishing is off.');
    await expect(provider.cancel('missing')).rejects.toThrow('Publishing is off.');
  });
});

describe('preflight against the shared capability contract', () => {
  const everyTarget = [
    { id: 1, platform: 'twitter', handle: '@gholmes', name: 'G.Holmes Designs' },
    { id: 2, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
    { id: 4, platform: 'instagram', handle: '@gholmes', name: 'G.Holmes Designs' },
    { id: 5, platform: 'linkedin', handle: '@gholmes', name: 'G.Holmes Designs' },
    { id: 6, platform: 'bluesky', handle: '@gholmes', name: 'G.Holmes Designs' },
    { id: 7, platform: 'youtube', handle: '@gholmes', name: 'G.Holmes Designs' },
    { id: 8, platform: 'tiktok', handle: '@gholmes', name: 'G.Holmes Designs' },
  ];

  it('reports every channel in SIGNAL_CHANNELS, blog as unavailable rather than unknown', () => {
    const plan = buildPublishPlan(
      add({
        channels: [...SIGNAL_CHANNELS],
        mediaUrls: ['https://cdn.example.com/clip.mp4'],
        format: 'VIDEO',
      }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(plan.channels.map((report) => report.channel)).toEqual([...SIGNAL_CHANNELS]);
    // `blog` is answered, not guessed at: no platform, no refusal, and a named reason.
    expect(reportFor(plan, 'blog')).toMatchObject({ status: 'NOT_AVAILABLE', platform: null });
    expect(reportFor(plan, 'blog').refusals).toEqual([]);
    expect(reportFor(plan, 'blog').warnings).toEqual([
      'Blog is not available from this provider. Publish it yourself and mark the post published.',
    ]);
    // One video reaches every social channel that takes one; the two that cannot say why.
    for (const channel of ['x', 'bsky', 'li', 'fb', 'yt', 'tt'] as const)
      expect(reportFor(plan, channel)).toMatchObject({ status: 'READY' });
    expect(reportFor(plan, 'ig')).toMatchObject({ status: 'READY' });
    expect(plan.refusals).toEqual([]);
    expect(plan.request).toBeDefined();
  });

  it('fails closed on a channel the contract does not answer for', () => {
    const post = add();
    const plan = buildPublishPlan(
      { ...post, channels: ['mastodon' as SignalChannel] },
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(plan, 'mastodon' as SignalChannel)).toMatchObject({
      status: 'BLOCKED',
      platform: null,
    });
    expect(reportFor(plan, 'mastodon' as SignalChannel).refusals[0]).toContain(
      'is not answered by the provider capability contract',
    );
    expect(plan.request).toBeUndefined();
  });

  it('judges a submission by its shape, so a story and a carousel meet different limits', () => {
    const story = buildPublishPlan(
      add({
        channels: ['ig', 'x'],
        format: 'STORY',
        mediaUrls: ['https://cdn.example.com/one.jpg'],
      }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(story, 'ig').kind).toBe('STORY');
    expect(reportFor(story, 'ig').warnings).toContain(
      'Instagram shows no caption on a story, so this text will not reach the reader.',
    );
    expect(reportFor(story, 'x').refusals).toEqual([
      "X does not accept a story from this provider. Change the post's format or remove X.",
    ]);

    const carousel = buildPublishPlan(
      add({
        channels: ['yt', 'ig'],
        format: 'CAROUSEL',
        mediaUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
      }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(carousel, 'ig')).toMatchObject({ status: 'READY', kind: 'CAROUSEL' });
    expect(reportFor(carousel, 'yt').refusals).toEqual([
      "YouTube does not accept a carousel from this provider. Change the post's format or remove YouTube.",
    ]);

    const reel = buildPublishPlan(
      add({
        channels: ['yt'],
        format: 'REEL',
        mediaUrls: ['https://cdn.example.com/short.mp4'],
      }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(reel, 'yt')).toMatchObject({ status: 'READY', kind: 'REEL' });
    expect(reportFor(reel, 'yt').warnings).toContain(
      'YouTube chooses its own thumbnail; this provider sends none.',
    );
  });

  it('refuses too much media, forbidden media, and an unclassifiable URL with a reason', () => {
    const plan = buildPublishPlan(
      add({
        channels: ['x', 'li'],
        mediaUrls: [
          'https://cdn.example.com/1.jpg',
          'https://cdn.example.com/2.jpg',
          'https://cdn.example.com/3.jpg',
          'https://cdn.example.com/4.jpg',
          'https://cdn.example.com/notes.pdf',
        ],
      }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(plan, 'x').refusals).toEqual([
      'X accepts at most 4 media items on a standard post and this post has 5. Remove 1.',
      'X does not accept a PDF on a standard post. Remove it.',
    ]);
    // LinkedIn takes a PDF, but only as a document post on its own.
    expect(reportFor(plan, 'li').refusals).toEqual([
      'LinkedIn posts a PDF only as a document post, on its own. Remove the other 4 media items.',
    ]);

    const unclassified = buildPublishPlan(
      add({ channels: ['x'], mediaUrls: ['https://cdn.example.com/asset'] }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(unclassified, 'x').warnings).toEqual([
      expect.stringContaining('could not be classified from its URL'),
    ]);
  });

  it('warns rather than refuses where the platform truncates, and refuses forbidden video', () => {
    // LinkedIn truncates at 3000 rather than rejecting, so the same over-limit caption that blocks
    // X only warns here — which is exactly why the reason has to sit on the channel.
    const long = buildPublishPlan(
      add({ text: 'x'.repeat(3001), channels: ['li', 'x'] }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(long, 'li')).toMatchObject({ status: 'READY' });
    expect(reportFor(long, 'li').warnings).toEqual([
      'LinkedIn limits captions to 3000 characters and this one is 3001. Remove 1.',
    ]);
    expect(reportFor(long, 'x').refusals).toEqual([
      'X limits captions to 280 characters and this one is 3001. Remove 2721.',
    ]);

    // A carousel is images by definition, so a video in one is refused rather than quietly sent.
    const carousel = buildPublishPlan(
      add({
        channels: ['x'],
        format: 'CAROUSEL',
        mediaUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.mp4'],
      }),
      everyTarget,
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(carousel, 'x').refusals).toEqual([
      'X does not accept video on a carousel. Remove it.',
    ]);
  });

  it('states a manual-finish shape as a warning rather than a refusal', () => {
    // Exercised against a constructed capability: TikTok is reachable both ways today, and the
    // preflight must still have words for a shape only a person can complete.
    const capability = {
      ...PUBLISH_CAPABILITIES.tiktok,
      kinds: {
        ...PUBLISH_CAPABILITIES.tiktok.kinds,
        POST: { ...PUBLISH_CAPABILITIES.tiktok.kinds.POST, automatic: false },
      },
    };
    const manual = preflightPlatform({
      capability,
      content: resolvedContent({ mediaUrls: ['https://cdn.example.com/a.jpg'] }),
    });
    expect(manual.refusals).toEqual([]);
    expect(manual.warnings).toEqual([
      'TikTok finishes a standard post by hand: the provider delivers it to the TikTok app and you complete it there.',
    ]);
    // With neither route the same shape refuses outright.
    const unreachable = preflightPlatform({
      capability: {
        ...capability,
        kinds: {
          ...capability.kinds,
          POST: { ...capability.kinds.POST, automatic: false, manualFinish: false },
        },
      },
      content: resolvedContent({ mediaUrls: ['https://cdn.example.com/a.jpg'] }),
    });
    expect(unreachable.refusals).toEqual([
      "TikTok does not accept a standard post from this provider. Change the post's format or remove TikTok.",
    ]);
  });

  it('refuses zero and several matching accounts differently, and never falls back', () => {
    const none = buildPublishPlan(
      add({ channels: ['fb'] }),
      [{ id: 3, platform: 'facebook', handle: 'other', name: 'AdDrive Media' }],
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(none, 'fb').refusals).toEqual([
      'Facebook has no connected account for G.Holmes Designs. Connect one in Post Bridge.',
    ]);
    expect(reportFor(none, 'fb').accountId).toBeUndefined();

    const several = buildPublishPlan(
      add({ channels: ['fb'] }),
      [
        { id: 2, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
        { id: 9, platform: 'facebook', handle: 'gholmes-designs', name: 'G.Holmes Designs' },
      ],
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(several, 'fb').refusals).toEqual([
      'Facebook resolved to 2 connected accounts for G.Holmes Designs and this app sends to exactly one. Disconnect the ones this campaign must not reach.',
    ]);
  });
});

describe('publish planning and submission', () => {
  it('resolves only the approved Facebook page and preflights platform media', () => {
    const post = add({ channels: ['fb', 'ig'], mediaUrls: [] });
    const plan = buildPublishPlan(post, targets, 'America/New_York', new Date('2026-01-01'));
    expect(plan.targets.find((target) => target.channel === 'fb')?.accountId).toBe(2);
    expect(reportFor(plan, 'fb')).toMatchObject({ status: 'READY', accountId: 2 });
    // The refusal belongs to Instagram, beside the account it is about, and says what to add.
    expect(reportFor(plan, 'ig')).toMatchObject({ status: 'BLOCKED', accountId: 4 });
    expect(reportFor(plan, 'ig').refusals).toContain(
      'Instagram requires media on a standard post. Add an image or a video.',
    );
    expect(plan.refusals).not.toContain(
      'Instagram requires media on a standard post. Add an image or a video.',
    );
    expect(publishPreviewRefusals(plan)).toContain(
      'Instagram requires media on a standard post. Add an image or a video.',
    );
  });

  it('carries the complete preflight rules for links, caption limits, media combinations and warnings', () => {
    const plan = buildPublishPlan(
      add({
        text: `${'x'.repeat(301)} gholmesdesigns.com`,
        channels: ['x', 'li', 'bsky', 'ig', 'yt', 'blog'],
        mediaUrls: ['https://cdn.example.com/video.mp4', 'https://cdn.example.com/guide.pdf'],
        status: 'PUBLISHED',
      }),
      [
        ...targets,
        { id: 5, platform: 'linkedin', handle: '@gholmes', name: 'G.Holmes Designs' },
        { id: 6, platform: 'bluesky', handle: '@gholmes', name: 'G.Holmes Designs' },
        { id: 7, platform: 'youtube', handle: '@gholmes', name: 'G.Holmes Designs' },
      ],
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(publishPreviewRefusals(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('X limits captions to 280 characters'),
        expect.stringContaining('Bluesky limits captions to 300 characters'),
        expect.stringContaining('video only when it is the only media item'),
        expect.stringContaining('YouTube requires exactly one video'),
      ]),
    );
    expect(publishPreviewWarnings(plan)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('marked this published'),
        expect.stringContaining('Instagram drops PDFs'),
        expect.stringContaining('X removes links'),
        expect.stringContaining('YouTube takes a title separate'),
        expect.stringContaining('Blog is not available from this provider'),
      ]),
    );
    // Every reason sits on the channel it is about, and the plan-level list keeps only what is
    // true of the whole submission.
    expect(reportFor(plan, 'x').refusals).toEqual([
      expect.stringContaining('X limits captions to 280 characters'),
      expect.stringContaining('X accepts a video only when it is the only media item'),
      // The source records no PDF support for X, so the contract refuses rather than assuming.
      expect.stringContaining('X does not accept a PDF'),
    ]);
    expect(reportFor(plan, 'li').refusals).toEqual([
      expect.stringContaining('LinkedIn accepts a video only when it is the only media item'),
      expect.stringContaining('LinkedIn posts a PDF only as a document post, on its own'),
    ]);
    expect(plan.warnings).toEqual([expect.stringContaining('marked this published')]);
  });

  it('refuses past, empty, unresolved and unscheduled plans with actionable reasons', () => {
    const base = add();
    const plan = buildPublishPlan(
      { ...base, text: '', channels: ['tt'], date: null },
      [],
      'America/New_York',
      new Date('2028-01-01'),
    );
    expect(plan.refusals).toEqual([
      'Post Bridge requires a caption.',
      'An unscheduled post has no publishing instant.',
      'No publishable channel has a resolved provider target.',
    ]);
    expect(reportFor(plan, 'tt').refusals).toEqual([
      'TikTok requires media on a standard post. Add an image or a video.',
      'TikTok has no connected account. Connect one in Post Bridge.',
    ]);
    const past = buildPublishPlan(add(), targets, 'America/New_York', new Date('2099-01-01'));
    expect(past.refusals).toContain(
      'The publishing instant is in the past. Choose a future date and time.',
    );
  });

  it('replans at commit, blocks an edited preview and a double submit', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01'),
    );
    const preview = await service.preview(post.id);
    db.prepare(
      "UPDATE signal_posts SET text='changed',updated_at='2026-02-01T00:00:00.000Z' WHERE id=?",
    ).run(post.id);
    await expect(service.submit(post.id, preview.planHash)).rejects.toThrow(
      /changed after preview/,
    );
    const fresh = await service.preview(post.id);
    const publication = await service.submit(post.id, fresh.planHash);
    expect(publication.state).toBe('SUBMITTED');
    await expect(
      service.submit(post.id, (await service.preview(post.id)).planHash),
    ).rejects.toThrow(/Double-submit/);
    expect(db.prepare('SELECT status FROM signal_posts WHERE id=?').get(post.id)).toEqual({
      status: 'DRAFT',
    });
    expect(listIntegrationEvents(db, { correlationId: publication.id })).toHaveLength(1);
    provider.result = {
      providerPostId: 'mock-publication',
      state: 'CONFIRMED',
      targets: [{ accountId: 1, outcome: 'SUCCESS', permalink: 'https://example.com/post' }],
    };
    expect((await service.reconcile(publication.id)).state).toBe('CONFIRMED');
    await provider.cancel(publication.providerPostId ?? 'mock-publication');
    expect(db.prepare('SELECT status FROM signal_posts WHERE id=?').get(post.id)).toEqual({
      status: 'DRAFT',
    });
  });

  it('records an ambiguous result as UNCONFIRMED and never retries it', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    provider.failure = new PublishProviderError('socket reset api_key=do-not-store', true);
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01'),
    );
    const preview = await service.preview(post.id);
    const publication = await service.submit(post.id, preview.planHash);
    expect(publication.state).toBe('UNCONFIRMED');
    expect(provider.submissions).toHaveLength(1);
    expect(publication.error).not.toContain('do-not-store');
  });

  it('records an answered provider failure as FAILED and protects publication history on delete', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    provider.failure = new PublishProviderError('request rejected', false);
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01'),
    );
    const failed = await service.submit(post.id, (await service.preview(post.id)).planHash);
    expect(failed.state).toBe('FAILED');
    await expect(service.cancelLiveForPost(post.id)).rejects.toThrow(/history protects/);
    await expect(service.reconcile('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('exposes preview, submit, list and reconcile only through a mock provider in HTTP tests', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    const app = createApp(db, {
      publish: provider,
      publishTimezone: 'America/New_York',
      now: () => new Date('2026-01-01'),
    });
    const preview = await request(app)
      .post(`/api/signal/posts/${post.id}/publish/preview`)
      .expect(200);
    const submitted = await request(app)
      .post(`/api/signal/posts/${post.id}/publish`)
      .send({ planHash: preview.body.planHash })
      .expect(201);
    await request(app)
      .get(`/api/signal/posts/${post.id}/publications`)
      .expect(200)
      .expect((response) => expect(response.body).toHaveLength(1));
    provider.result = { providerPostId: submitted.body.providerPostId, state: 'CONFIRMED' };
    await request(app)
      .post(`/api/signal/publications/${submitted.body.id}/reconcile`)
      .expect(200)
      .expect((response) => expect(response.body.state).toBe('CONFIRMED'));
    await request(app)
      .post(`/api/signal/posts/${post.id}/publish`)
      .send({ planHash: 'b'.repeat(64) })
      .expect(409);
  });
});
/**
 * Planning status and delivery are two facts, and these are the tests that hold them apart.
 *
 * The interesting cases are the ones where a single word would have been wrong: a provider result
 * that would like to move the post's status and must not, a submission where one account succeeded
 * and another did not, and a delivery the provider accepted that is still not out because a person
 * has not finished it.
 */
describe('delivery mode, decided from the capability contract', () => {
  const manualOnly = (base: PublishPlatformCapability, providerDraft = false) => ({
    ...base,
    providerDraft,
    kinds: {
      ...base.kinds,
      POST: { ...base.kinds.POST, automatic: false, manualFinish: true },
    },
  });

  it('answers every channel, and never guesses at one the contract does not cover', () => {
    // Every channel Signal plans for, at its ordinary shape. `blog` is the permanent unsupported
    // one; an unrecognised channel is unsupported too rather than assumed automatic.
    expect(
      SIGNAL_CHANNELS.map((channel) => deliveryModeFor(publishPlatformFor(channel), 'POST')),
    ).toEqual([
      'UNSUPPORTED',
      'AUTOMATIC',
      'AUTOMATIC',
      'AUTOMATIC',
      'AUTOMATIC',
      'AUTOMATIC',
      'AUTOMATIC',
      'AUTOMATIC',
    ]);
    expect(deliveryModeFor(publishPlatformFor('not-a-channel'), 'POST')).toBe('UNSUPPORTED');
    expect(deliveryModeFor(undefined, 'POST')).toBe('UNSUPPORTED');
    // A shape the platform does not take is unsupported for that post even though the platform
    // itself is reachable — YouTube takes no carousel.
    expect(deliveryModeFor('youtube', 'CAROUSEL')).toBe('UNSUPPORTED');
    expect(deliveryModeFor('youtube', 'REEL')).toBe('AUTOMATIC');
  });

  it('prefers automatic, then a provider draft, then a person', () => {
    // Constructed capabilities, for the same reason preflight's manual-finish test uses one:
    // every connected platform publishes automatically today, and the other three routes still
    // have to be decided rather than left to whichever one happens to ship first.
    const tiktok = PUBLISH_CAPABILITIES.tiktok;
    expect(deliveryModeForCapability(tiktok, 'POST')).toBe('AUTOMATIC');
    expect(deliveryModeForCapability(manualOnly(tiktok), 'POST')).toBe('MANUAL_FINISH');
    expect(deliveryModeForCapability(manualOnly(tiktok, true), 'POST')).toBe('PROVIDER_DRAFT');
    expect(deliveryModeForCapability(undefined, 'POST')).toBe('UNSUPPORTED');
    // Both routes available is not a tie: automatic wins, and the draft flag does not change it.
    expect(deliveryModeForCapability({ ...tiktok, providerDraft: true }, 'POST')).toBe('AUTOMATIC');
  });

  it('names what a person has to do, and where', () => {
    expect(deliveryModeInstruction('MANUAL_FINISH', 'TikTok')).toContain('Open TikTok');
    expect(deliveryModeInstruction('PROVIDER_DRAFT', 'TikTok')).toContain('Post Bridge');
    expect(deliveryModeInstruction('UNSUPPORTED', 'Blog')).toContain('Publish it yourself');
    expect(deliveryModeInstruction('AUTOMATIC', 'X')).toContain('Nothing is left for you to do');
    expect(deliveryModeNeedsPerson('AUTOMATIC')).toBe(false);
    expect(deliveryModeNeedsPerson('UNSUPPORTED')).toBe(false);
  });

  it('groups the seven states without adding to them, and keeps every state readable', () => {
    expect(PUBLICATION_STATES.map((state) => PUBLICATION_STATE_GROUP[state])).toEqual([
      'IN_FLIGHT',
      'IN_FLIGHT',
      'DELIVERED',
      'ATTENTION',
      'ATTENTION',
      'ATTENTION',
      'STOPPED',
    ]);
    for (const state of PUBLICATION_STATES) {
      expect(PUBLICATION_STATE_LABEL[state]).toBeTruthy();
      expect(PUBLICATION_STATE_DESCRIPTION[state]).toBeTruthy();
      expect(DELIVERY_GROUP_LABEL[PUBLICATION_STATE_GROUP[state]]).toBeTruthy();
    }
  });

  it('reports a target apart from its publication where the two disagree', () => {
    const target = (over: Partial<SignalPublicationTarget> = {}): SignalPublicationTarget => ({
      channel: 'x',
      platform: 'twitter',
      accountId: 1,
      handle: '@gholmes',
      mode: 'AUTOMATIC',
      ...over,
    });
    // Half of a PARTIAL submission is delivered and half is not, and each row says which.
    expect(deliveryTargetSummary({ state: 'PARTIAL' }, target({ outcome: 'SUCCESS' }))).toEqual({
      label: 'Delivered',
      group: 'DELIVERED',
    });
    expect(deliveryTargetSummary({ state: 'PARTIAL' }, target({ outcome: 'FAILURE' }))).toEqual({
      label: 'Not delivered',
      group: 'ATTENTION',
    });
    // The provider accepting a manual-finish delivery is not the same as it being out.
    const waiting = target({ mode: 'MANUAL_FINISH', outcome: 'SUCCESS' });
    expect(deliveryTargetSummary({ state: 'SUBMITTED' }, waiting)).toEqual({
      label: 'Waiting for you to finish',
      group: 'ATTENTION',
    });
    expect(deliveryTargetAwaitsPerson(waiting)).toBe(true);
    const finished = { ...waiting, manualCompletedAt: '2026-01-02T00:00:00.000Z' };
    expect(deliveryTargetSummary({ state: 'SUBMITTED' }, finished)).toEqual({
      label: 'Finished by hand',
      group: 'DELIVERED',
    });
    expect(deliveryTargetAwaitsPerson(finished)).toBe(false);
    // With no outcome of its own a target falls back to what the publication says.
    expect(deliveryTargetSummary({ state: 'SUBMITTING' }, target())).toEqual({
      label: PUBLICATION_STATE_LABEL.SUBMITTING,
      group: 'IN_FLIGHT',
    });
  });
});

describe('bounded reconciliation', () => {
  const publication = (over: Partial<SignalPublication> = {}) => ({
    state: 'SUBMITTED' as const,
    providerPostId: 'provider-1',
    scheduledInstant: '2026-09-14T13:00:00.000Z',
    checkAttempts: 0,
    ...over,
  });

  it('waits for the instant, then widens, then gives up', () => {
    const before = reconcileSchedule(publication(), new Date('2026-09-14T12:00:00.000Z'));
    expect(before).toMatchObject({ dueAt: '2026-09-14T13:00:00.000Z', due: false });
    expect(reconcileSchedule(publication(), new Date('2026-09-14T13:00:01.000Z')).due).toBe(true);

    // Each attempt buys a longer wait than the last, measured from the check that was made.
    const gaps = RECONCILE_INTERVALS_MINUTES.map((_, index) => {
      const schedule = reconcileSchedule(
        publication({ checkAttempts: index + 1, checkedAt: '2026-09-14T13:00:00.000Z' }),
        new Date('2026-09-14T13:00:00.000Z'),
      );
      return (
        (Date.parse(schedule.dueAt as string) - Date.parse('2026-09-14T13:00:00.000Z')) / 60000
      );
    });
    expect(gaps).toEqual([...RECONCILE_INTERVALS_MINUTES]);
    expect(gaps.every((gap, index) => index === 0 || gap > (gaps[index - 1] as number))).toBe(true);

    const spent = reconcileSchedule(
      publication({ checkAttempts: RECONCILE_MAX_ATTEMPTS, checkedAt: '2026-09-14T13:00:00.000Z' }),
      new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(spent).toEqual({ due: false, exhausted: true });
  });

  it('never schedules a check there is no answer left to ask for', () => {
    for (const state of PUBLICATION_STATES)
      expect(reconcileSchedule(publication({ state }), new Date('2030-01-01')).due).toBe(
        isReconcilableState(state),
      );
    // Nothing to ask about without a provider id, and nothing pretends otherwise.
    expect(
      reconcileSchedule({ ...publication(), providerPostId: undefined }, new Date('2030-01-01')),
    ).toEqual({ due: false, exhausted: false });
  });
});

describe('planning status and delivery stay apart end to end', () => {
  const serviceAt = (provider: MockPublishProvider, instant: string) =>
    new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date(instant),
    );

  it('records mode and handle per target and never writes PUBLISHED from a provider result', async () => {
    const post = add({ channels: ['x', 'blog'] });
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider, '2026-01-01T00:00:00.000Z');

    const preview = await service.preview(post.id);
    // The preview knows the route before anything is sent, per channel and per target.
    expect(preview.targets).toEqual([
      { channel: 'x', platform: 'twitter', accountId: 1, handle: '@gholmes', mode: 'AUTOMATIC' },
    ]);
    expect(reportFor(preview, 'blog').mode).toBe('UNSUPPORTED');

    const publication = await service.submit(post.id, preview.planHash);
    expect(publication.targets).toEqual([
      {
        channel: 'x',
        platform: 'twitter',
        accountId: 1,
        handle: '@gholmes',
        mode: 'AUTOMATIC',
      },
    ]);
    expect(publication.checkAttempts).toBe(0);
    expect(publication.checkedAt).toBeUndefined();

    // The provider confirming is the strongest result there is, and it still does not touch the
    // planning status: that column has one writer, and it is the person.
    provider.result = {
      providerPostId: 'mock-publication',
      state: 'CONFIRMED',
      targets: [{ accountId: 1, outcome: 'SUCCESS', permalink: 'https://x.example/1' }],
    };
    const confirmed = await service.reconcile(publication.id);
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.targets[0]).toMatchObject({
      outcome: 'SUCCESS',
      permalink: 'https://x.example/1',
    });
    expect(db.prepare('SELECT status FROM signal_posts WHERE id=?').get(post.id)).toEqual({
      status: 'DRAFT',
    });
  });

  it('keeps a partial multi-account result visible per target', async () => {
    const post = add({ channels: ['x', 'fb'] });
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider, '2026-01-01T00:00:00.000Z');
    provider.result = {
      providerPostId: 'mock-publication',
      state: 'PARTIAL',
      targets: [
        { accountId: 1, outcome: 'SUCCESS', permalink: 'https://x.example/1' },
        { accountId: 2, outcome: 'FAILURE', error: 'Page token rejected api_key=do-not-store' },
      ],
    };
    const publication = await service.submit(post.id, (await service.preview(post.id)).planHash);
    expect(publication.state).toBe('PARTIAL');
    // Two rows, two different answers — the whole reason a publication cannot be one word.
    expect(publication.targets.map((target) => [target.channel, target.outcome])).toEqual([
      ['fb', 'FAILURE'],
      ['x', 'SUCCESS'],
    ]);
    expect(deliveryTargetSummary(publication, publication.targets[0]!).group).toBe('ATTENTION');
    expect(deliveryTargetSummary(publication, publication.targets[1]!).group).toBe('DELIVERED');
    expect(publication.targets[0]?.error).not.toContain('do-not-store');
  });

  it('holds an automatic check to its schedule and gives up into UNCONFIRMED', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => now,
    );
    const publication = await service.submit(post.id, (await service.preview(post.id)).planHash);

    // Before the publishing instant an automatic check is answered from storage, with no call.
    const early = await service.reconcile(publication.id, { automatic: true });
    expect(provider.checks).toHaveLength(0);
    expect(early.checkAttempts).toBe(0);

    // A person asking is never held to that schedule, and never spends an attempt either.
    const manual = await service.reconcile(publication.id);
    expect(provider.checks).toHaveLength(1);
    expect(manual.checkAttempts).toBe(0);
    expect(manual.checkedAt).toBe('2026-01-01T00:00:00.000Z');

    // Past the instant the budget is spent one attempt at a time, and the last one gives up
    // rather than polling for ever.
    now = new Date('2027-08-15T00:00:00.000Z');
    for (let attempt = 1; attempt <= RECONCILE_MAX_ATTEMPTS; attempt += 1) {
      now = new Date(Date.parse('2027-08-15T00:00:00.000Z') + attempt * 24 * 3600_000);
      const checked = await service.reconcile(publication.id, { automatic: true });
      expect(checked.checkAttempts).toBe(attempt);
      expect(checked.state).toBe(attempt === RECONCILE_MAX_ATTEMPTS ? 'UNCONFIRMED' : 'SUBMITTED');
    }
    const givenUp = service.get(publication.id) as SignalPublication;
    expect(givenUp.error).toContain(`${RECONCILE_MAX_ATTEMPTS} checks`);
    // And the schedule stops asking, while a person still can.
    expect(reconcileSchedule(givenUp, now).due).toBe(false);
    expect(listIntegrationEvents(db, { correlationId: publication.id }).length).toBeGreaterThan(1);
  });

  it('lets a person finish a manual delivery, once, and only where there is something to finish', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider, '2026-01-01T00:00:00.000Z');
    const publication = await service.submit(post.id, (await service.preview(post.id)).planHash);

    // An automatic delivery has nothing for anyone to finish, and saying so is a refusal rather
    // than a no-op: marking it would be a person overwriting the provider's own answer.
    expect(() => service.markTargetFinished(publication.id, 1)).toThrow(
      /nothing for you to finish/,
    );
    expect(() => service.markTargetFinished(publication.id, 99)).toThrow(/not on this publication/);

    // A manual-finish target is the case the control exists for. No connected platform produces
    // one today, so the row is set to the mode the contract would give it.
    db.prepare(
      "UPDATE signal_publication_targets SET mode='MANUAL_FINISH',outcome='SUCCESS' WHERE publication_id=?",
    ).run(publication.id);
    const waiting = service.get(publication.id) as SignalPublication;
    expect(deliveryTargetSummary(waiting, waiting.targets[0]!).label).toBe(
      'Waiting for you to finish',
    );

    const finished = service.markTargetFinished(publication.id, 1);
    expect(finished.targets[0]?.manualCompletedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(deliveryTargetSummary(finished, finished.targets[0]!).group).toBe('DELIVERED');
    // Finishing is about the delivery and nothing else: the post's own status is untouched.
    expect(db.prepare('SELECT status FROM signal_posts WHERE id=?').get(post.id)).toEqual({
      status: 'DRAFT',
    });
    expect(() => service.markTargetFinished(publication.id, 1)).toThrow(/already marked/);
  });

  it('exposes the automatic gate and the manual finish over HTTP, through the mock alone', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    const app = createApp(db, {
      publish: provider,
      publishTimezone: 'America/New_York',
      now: () => new Date('2026-01-01'),
    });
    const preview = await request(app)
      .post(`/api/signal/posts/${post.id}/publish/preview`)
      .expect(200);
    const submitted = await request(app)
      .post(`/api/signal/posts/${post.id}/publish`)
      .send({ planHash: preview.body.planHash })
      .expect(201);

    // An automatic check that is not due costs the provider nothing.
    await request(app)
      .post(`/api/signal/publications/${submitted.body.id}/reconcile`)
      .send({ automatic: true })
      .expect(200);
    expect(provider.checks).toHaveLength(0);

    await request(app)
      .post(`/api/signal/publications/${submitted.body.id}/targets/1/finish`)
      .expect(409);
    db.prepare(
      "UPDATE signal_publication_targets SET mode='MANUAL_FINISH' WHERE publication_id=?",
    ).run(submitted.body.id);
    await request(app)
      .post(`/api/signal/publications/${submitted.body.id}/targets/1/finish`)
      .expect(200)
      .expect((response) => expect(response.body.targets[0].manualCompletedAt).toBeTruthy());
    await request(app)
      .post(`/api/signal/publications/${submitted.body.id}/targets/404/finish`)
      .expect(404);
  });
});

describe('platform and account content variants', () => {
  const everyTarget = [
    ...targets,
    { id: 5, platform: 'linkedin', handle: '@gholmes', name: 'G.Holmes Designs' },
    { id: 7, platform: 'youtube', handle: '@gholmes', name: 'G.Holmes Designs' },
  ];
  const plan = (post: SignalPost, variants: PublishVariantRecord[]) =>
    buildPublishPlan(post, everyTarget, 'America/New_York', new Date('2026-01-01'), variants);

  it('plans a post with no variants exactly as it did before variants existed', () => {
    const post = add({ channels: ['x'] });
    const without = buildPublishPlan(post, targets, 'America/New_York', new Date('2026-01-01'));
    expect(plan(post, []).planHash).toBe(without.planHash);
    expect(without.request?.platformConfigurations).toBeUndefined();
    expect(reportFor(without, 'x').content).toMatchObject({
      caption: post.text,
      postKind: 'POST',
      deliveryMode: 'AUTOMATIC',
    });
  });

  it('resolves each channel from its own layers and reports where every value came from', () => {
    const post = add({ text: 'The long form post', channels: ['x', 'li'] });
    const resolved = plan(post, [
      { platform: 'twitter', accountId: null, caption: 'The short version' },
      { platform: 'twitter', accountId: 1, firstComment: 'gholmesdesigns.com' },
    ]);
    expect(reportFor(resolved, 'x').content).toMatchObject({
      caption: 'The short version',
      firstComment: 'gholmesdesigns.com',
    });
    expect(reportFor(resolved, 'x').content?.sources).toMatchObject({
      caption: 'PLATFORM',
      firstComment: 'ACCOUNT',
      mediaUrls: 'BASE',
    });
    // LinkedIn was never mentioned, so it still receives the post.
    expect(reportFor(resolved, 'li').content?.caption).toBe('The long form post');
  });

  it('sends one platform configuration per tailored platform and none for the rest', () => {
    const post = add({
      text: 'The long form post',
      channels: ['x', 'li', 'yt'],
      mediaUrls: ['https://cdn.example.com/clip.mp4'],
      format: 'VIDEO',
    });
    const resolved = plan(post, [
      { platform: 'twitter', accountId: null, caption: 'The short version' },
      { platform: 'youtube', accountId: null, title: 'How clarity wins work' },
    ]);
    expect(publishPreviewRefusals(resolved)).toEqual([]);
    expect(resolved.request?.caption).toBe('The long form post');
    expect(resolved.request?.platformConfigurations).toEqual([
      { platform: 'twitter', caption: 'The short version' },
      { platform: 'youtube', title: 'How clarity wins work' },
    ]);
    // A YouTube title that is set is a title the caption no longer stands in for.
    expect(reportFor(resolved, 'yt').warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('takes a title separate')]),
    );
  });

  it('measures a caption limit against the caption the override produced', () => {
    const post = add({ text: 'Short enough for X', channels: ['x'] });
    const resolved = plan(post, [
      { platform: 'twitter', accountId: null, caption: 'x'.repeat(281) },
    ]);
    expect(reportFor(resolved, 'x').refusals).toEqual([
      'X limits captions to 280 characters and this one is 281. Remove 1.',
    ]);
  });

  it('refuses a title the platform will not carry and one that is over its limit', () => {
    const post = add({
      channels: ['yt'],
      mediaUrls: ['https://cdn.example.com/clip.mp4'],
      format: 'VIDEO',
    });
    const overLong = plan(post, [{ platform: 'youtube', accountId: null, title: 'y'.repeat(101) }]);
    expect(reportFor(overLong, 'yt').refusals).toEqual([
      'YouTube limits the title to 100 characters and this one is 101. Remove 1.',
    ]);
    // A field the contract does not carry refuses rather than being dropped, because a title
    // silently discarded is a video published under the wrong name.
    expect(
      preflightPlatform({
        capability: PUBLISH_CAPABILITIES.bluesky,
        content: { ...resolvedContent(), title: 'Nowhere to put this' },
      }).refusals,
    ).toEqual(['Bluesky takes no title from this provider, and one is set for it. Remove it.']);
  });

  it('takes a placement override as the shape, with its own media rules', () => {
    const post = add({
      channels: ['ig'],
      mediaUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
      format: 'CAROUSEL',
    });
    const asStory = plan(post, [{ platform: 'instagram', accountId: null, postKind: 'STORY' }]);
    expect(reportFor(asStory, 'ig').kind).toBe('STORY');
    // A story is exactly one item, so a two-image carousel refuses as a story and says why.
    expect(reportFor(asStory, 'ig').refusals).toEqual([
      'Instagram accepts at most 1 media item on a story and this post has 2. Remove 1.',
    ]);
    const oneImage = plan(add({ channels: ['ig'], mediaUrls: ['https://cdn.example.com/a.jpg'] }), [
      { platform: 'instagram', accountId: null, postKind: 'STORY' },
    ]);
    expect(publishPreviewRefusals(oneImage)).toEqual([]);
    expect(reportFor(oneImage, 'ig').warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('shows no caption on a story')]),
    );
    // A story is a real provider placement; a reel is not, and none is sent for one.
    expect(oneImage.request?.platformConfigurations).toEqual([
      { platform: 'instagram', story: true },
    ]);
  });

  it('writes a disclosure into the caption and counts it against the limit', () => {
    const post = add({ text: 'x'.repeat(240), channels: ['x'] });
    const resolved = plan(post, [
      { platform: 'twitter', accountId: null, discloseSyntheticMedia: true },
    ]);
    expect(reportFor(resolved, 'x').content?.caption).toContain(
      'Contains AI-generated or synthetically altered content.',
    );
    expect(reportFor(resolved, 'x').warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('written into the caption')]),
    );
    // 240 characters of post, a blank line, and a 54-character sentence is over 280, and X refuses.
    expect(reportFor(resolved, 'x').refusals).toEqual([
      expect.stringContaining('X limits captions to 280 characters'),
    ]);
  });

  it('sends the selected media and refuses when two channels were given different sets', () => {
    const media = ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'];
    const agreed = plan(add({ channels: ['x', 'li'], mediaUrls: media }), [
      { platform: 'twitter', accountId: null, mediaUrls: [media[1] as string] },
      { platform: 'linkedin', accountId: null, mediaUrls: [media[1] as string] },
    ]);
    expect(publishPreviewRefusals(agreed)).toEqual([]);
    expect(agreed.request?.mediaUrls).toEqual([media[1]]);

    const conflicting = plan(add({ channels: ['x', 'li'], mediaUrls: media }), [
      { platform: 'twitter', accountId: null, mediaUrls: [media[1] as string] },
    ]);
    expect(conflicting.refusals).toEqual([
      'This provider sends one set of media per submission and these channels were given different media: X (1 item); LinkedIn (2 items). Give them the same media, or publish them separately.',
    ]);
    expect(conflicting.request).toBeUndefined();
  });

  it('leaves out media the post no longer carries, and says it did', () => {
    const post = add({ channels: ['li'], mediaUrls: ['https://cdn.example.com/a.jpg'] });
    const resolved = plan(post, [
      {
        platform: 'linkedin',
        accountId: null,
        mediaUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/gone.jpg'],
      },
    ]);
    expect(reportFor(resolved, 'li').content?.mediaUrls).toEqual(['https://cdn.example.com/a.jpg']);
    expect(reportFor(resolved, 'li').warnings).toEqual([
      'LinkedIn was given 1 media item the post no longer carries, and it was left out. Choose its media again.',
    ]);
  });

  it('states that an account caption is delivered as the platform configuration', () => {
    const resolved = plan(add({ channels: ['x'] }), [
      { platform: 'twitter', accountId: 1, caption: 'Just for this handle' },
    ]);
    expect(reportFor(resolved, 'x').content?.caption).toBe('Just for this handle');
    expect(reportFor(resolved, 'x').warnings).toEqual([
      expect.stringContaining('carries one set of content per platform'),
    ]);
    expect(resolved.request?.platformConfigurations).toEqual([
      { platform: 'twitter', caption: 'Just for this handle' },
    ]);
  });

  it('changes the plan hash when a variant changes, so a stale confirmation refuses', () => {
    const post = add({ channels: ['x'] });
    const before = plan(post, []);
    const after = plan(post, [
      { platform: 'twitter', accountId: null, caption: 'The short version' },
    ]);
    expect(after.planHash).not.toBe(before.planHash);
  });

  /**
   * The claim the card makes about the server, tested as behaviour rather than as a promise.
   *
   * A preview resolves media, checks it against the contract, and reports it. None of that requires
   * knowing anything about the file at the other end of the URL, and this proves nothing tried: the
   * spy is the whole of `fetch`, so any attempt to reach a media host, a cover image, or the
   * provider itself would be caught here.
   */
  it('fetches nothing at all while building a preview', async () => {
    const post = add({
      channels: ['x'],
      mediaUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/clip.mp4'],
    });
    replacePostVariants(db, post.id, {
      variants: [
        {
          platform: 'twitter',
          accountId: null,
          caption: 'The short version',
          mediaUrls: ['https://cdn.example.com/a.jpg'],
        },
      ],
    });
    const original = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = (input: RequestInfo | URL) => {
      attempts.push(String(input));
      throw new Error('The server must not fetch a preview URL.');
    };
    try {
      const service = new PublishService(
        db,
        new LocalSignalProvider(db),
        new MockPublishProvider(targets),
        'America/New_York',
        () => new Date('2026-01-01'),
      );
      const preview = await service.preview(post.id);
      expect(reportFor(preview, 'x').content?.mediaUrls).toEqual(['https://cdn.example.com/a.jpg']);
      expect(attempts).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('storing content variants', () => {
  const media = ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'];
  const app = () => createApp(db, { publish: new MockPublishProvider(targets) });

  it('replaces the whole set and drops a layer that overrides nothing', () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    replacePostVariants(db, post.id, {
      variants: [
        { platform: 'twitter', accountId: null, caption: 'First' },
        { platform: 'linkedin', accountId: null, caption: 'Second' },
      ],
    });
    const replaced = replacePostVariants(db, post.id, {
      variants: [
        { platform: 'twitter', accountId: null, caption: '   ' },
        { platform: 'linkedin', accountId: null, caption: 'Still here' },
      ],
    });
    expect(replaced.map((variant) => variant.platform)).toEqual(['linkedin']);
    expect(replaced[0]).toMatchObject({ caption: 'Still here', accountId: null });
  });

  it('keeps an empty media selection apart from no selection across the round trip', () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    const stored = replacePostVariants(db, post.id, {
      variants: [
        { platform: 'twitter', accountId: null, mediaUrls: [] },
        { platform: 'linkedin', accountId: null, caption: 'No selection here' },
      ],
    });
    expect(stored.find((v) => v.platform === 'twitter')?.mediaUrls).toEqual([]);
    expect(stored.find((v) => v.platform === 'linkedin')?.mediaUrls).toBeUndefined();
  });

  it('refuses a field the platform does not carry, and media the post does not have', () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    expect(() =>
      replacePostVariants(db, post.id, {
        variants: [{ platform: 'bluesky', accountId: null, title: 'Nowhere' }],
      }),
    ).toThrow(/Bluesky takes no title/);
    expect(() =>
      replacePostVariants(db, post.id, {
        variants: [{ platform: 'youtube', accountId: null, thumbnailUrl: 'https://x.test/t.jpg' }],
      }),
    ).toThrow(/YouTube takes no thumbnail/);
    expect(() =>
      replacePostVariants(db, post.id, {
        variants: [{ platform: 'twitter', accountId: null, mediaUrls: ['https://x.test/new.jpg'] }],
      }),
    ).toThrow(/media the post already carries/);
    expect(() =>
      replacePostVariants(db, post.id, {
        variants: [{ platform: 'twitter', accountId: null, postKind: 'STORY' }],
      }),
    ).toThrow(/X does not accept a story/);
  });

  it('answers the routes, refuses a bad layer with a 400, and goes with the post', async () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    await request(app())
      .put(`/api/signal/posts/${post.id}/variants`)
      .send({ variants: [{ platform: 'twitter', accountId: null, caption: 'The short version' }] })
      .expect(200)
      .expect((response) => expect(response.body[0].caption).toBe('The short version'));
    await request(app())
      .get(`/api/signal/posts/${post.id}/variants`)
      .expect(200)
      .expect((response) => expect(response.body).toHaveLength(1));
    await request(app())
      .put(`/api/signal/posts/${post.id}/variants`)
      .send({ variants: [{ platform: 'bluesky', accountId: null, title: 'Nowhere' }] })
      .expect(400)
      .expect((response) => expect(response.body.error).toMatch(/Bluesky takes no title/));
    await request(app()).get('/api/signal/posts/missing/variants').expect(404);
    // The layers belong to the post and go when it does.
    db.prepare('DELETE FROM signal_posts WHERE id=?').run(post.id);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM signal_post_variants WHERE post_id=?').get(post.id),
    ).toEqual({ n: 0 });
  });

  it('submits the tailored request the preview showed, without contacting a real provider', async () => {
    const post = add({
      channels: ['x'],
      mediaUrls: media,
      date: '2027-08-14',
      status: 'SCHEDULED',
    });
    const provider = new MockPublishProvider(targets);
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01'),
    );
    replacePostVariants(db, post.id, {
      variants: [
        {
          platform: 'twitter',
          accountId: null,
          caption: 'The short version',
          firstComment: 'gholmesdesigns.com',
          mediaUrls: [media[0] as string],
        },
      ],
    });
    const preview = await service.preview(post.id);
    expect(publishPreviewRefusals(preview)).toEqual([]);
    await service.submit(post.id, preview.planHash);
    expect(provider.submissions).toHaveLength(1);
    expect(provider.submissions[0]).toMatchObject({
      caption: post.text,
      mediaUrls: [media[0]],
      platformConfigurations: [
        {
          platform: 'twitter',
          caption: 'The short version',
          firstComment: 'gholmesdesigns.com',
        },
      ],
    });
  });
});

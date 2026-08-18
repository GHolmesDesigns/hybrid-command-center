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
  publishPreviewRefusals,
  publishPreviewWarnings,
  PUBLICATION_STATES,
  type PublishChannelReport,
  type PublishPreview,
} from '../../shared/publish.ts';
import { SIGNAL_CHANNELS, type SignalChannel } from '../../shared/signal.ts';
import { PUBLISH_CAPABILITIES } from '../../shared/publish-capabilities.ts';
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
      kind: 'POST',
      caption: 'A clear campaign post',
      mediaKinds: ['image'],
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
      kind: 'POST',
      caption: 'A clear campaign post',
      mediaKinds: ['image'],
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

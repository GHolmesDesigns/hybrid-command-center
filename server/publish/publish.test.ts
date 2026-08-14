import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { LocalSignalProvider } from '../signal/read.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { buildPublishPlan, publishInstantFor } from './plan.ts';
import { MockPublishProvider } from './mock-provider.ts';
import { PublishProviderError } from './provider.ts';
import { UnavailablePublishProvider } from './provider.ts';
import { PublishService } from './service.ts';
import { PUBLICATION_STATES } from '../../shared/publish.ts';
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

describe('publish planning and submission', () => {
  it('resolves only the approved Facebook page and preflights platform media', () => {
    const post = add({ channels: ['fb', 'ig'], mediaUrls: [] });
    const plan = buildPublishPlan(post, targets, 'America/New_York', new Date('2026-01-01'));
    expect(plan.targets.find((target) => target.channel === 'fb')?.accountId).toBe(2);
    expect(plan.refusals).toContain('instagram requires media.');
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
    expect(plan.refusals).toEqual(
      expect.arrayContaining([
        expect.stringContaining('twitter limits captions'),
        expect.stringContaining('bluesky limits captions'),
        expect.stringContaining('video only when it is the only'),
        expect.stringContaining('youtube requires exactly one video'),
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('marked this published'),
        expect.stringContaining('Instagram drops PDFs'),
        expect.stringContaining('X removes links'),
        expect.stringContaining('YouTube will use the caption'),
        expect.stringContaining('Blog is not published'),
      ]),
    );
  });

  it('refuses past, empty, unresolved and unscheduled plans with actionable reasons', () => {
    const base = add();
    const plan = buildPublishPlan(
      { ...base, text: '', channels: ['tt'], date: null },
      [],
      'America/New_York',
      new Date('2028-01-01'),
    );
    expect(plan.refusals).toEqual(
      expect.arrayContaining([
        'Post Bridge requires a caption.',
        'An unscheduled post has no publishing instant.',
        'tiktok requires media.',
        'tiktok needs exactly one connected target.',
        'No publishable channel has a resolved provider target.',
      ]),
    );
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

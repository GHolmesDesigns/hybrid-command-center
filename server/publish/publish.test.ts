import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { LocalSignalProvider } from '../signal/read.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { buildPublishPlan, preflightPlatform, publishInstantFor } from './plan.ts';
import { MockBufferWriteProvider, MockPublishProvider } from './mock-provider.ts';
import { PublishProviderError } from './provider.ts';
import { UnavailablePublishProvider, type PublishRequest } from './provider.ts';
import { PublishService } from './service.ts';
import {
  deliveryModeFor,
  deliveryModeForCapability,
  deliveryModeInstruction,
  deliveryModeNeedsPerson,
  deliveryTargetAwaitsPerson,
  deliveryTargetSummary,
  isReconcilableState,
  providerActionOffer,
  publicationDriftFields,
  publishPreviewRefusals,
  publishPreviewWarnings,
  reconcileSchedule,
  DELIVERY_GROUP_LABEL,
  PUBLICATION_STATE_DESCRIPTION,
  PUBLICATION_STATE_GROUP,
  PUBLICATION_STATE_LABEL,
  PUBLICATION_STATES,
  PROVIDER_ACTIONS,
  RECONCILE_INTERVALS_MINUTES,
  RECONCILE_MAX_ATTEMPTS,
  shouldReconcileAfterSubmit,
  type DeliveryMode,
  type ProviderAction,
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
import { replacePostVariants, deletePost, getPost } from '../signal/service.ts';
import { SIGNAL_CHANNELS, type SignalChannel, type SignalPost } from '../../shared/signal.ts';
import {
  publishPlatformFor,
  PUBLISH_CAPABILITIES,
  type PublishPlatformCapability,
} from '../../shared/publish-capabilities.ts';
import request from 'supertest';
import { createApp } from '../app.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { MockDriveMediaProvider } from '../drive/mock-provider.ts';
import type { SignalPostMedia } from '../../shared/signal-media.ts';
import { postBridgePlatformConfigurations } from './post-bridge-wire.ts';
import { BUFFER_PROVIDER, BUFFER_WRITE_EVIDENCE } from '../../shared/buffer.ts';
import type { PublishTarget } from './provider.ts';
import { resolveProviderAccounts } from './accounts.ts';
import { BufferWriteError, UnavailableBufferWriteProvider } from './buffer/write-provider.ts';

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
const driveDescriptor = (id: string, sizeBytes = 4): SignalPostMedia => ({
  source: 'DRIVE',
  url: `https://drive.google.com/file/d/${id}/view`,
  driveFileId: id,
  driveName: `${id}.png`,
  mimeType: 'image/png',
  sizeBytes,
  driveVersion: '7',
  driveModifiedAt: '2026-03-01T12:00:00.000Z',
  driveChecksum: 'd41d8cd98f00b204e9800998ecf8427e',
  driveVerifiedAt: '2026-08-20T09:00:00.000Z',
});
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

  /**
   * The conversion caches one `Intl.DateTimeFormat` per zone (#245), so the thing worth proving is
   * that a cached formatter only ever answers for the zone it was built for. Every wall time here
   * is the same, which is what makes a leak visible: a zone reading another's offset would return
   * another zone's instant rather than fail. The list runs twice, so the second pass reads
   * formatters the first pass built, and it mixes a whole-hour offset, a half-hour one, a
   * no-offset zone, and both hemispheres' summer.
   */
  it('converts each zone by its own offset, on a cached formatter as on a fresh one', () => {
    const expected = [
      ['UTC', '2026-06-01T09:00:00.000Z'],
      ['Asia/Kolkata', '2026-06-01T03:30:00.000Z'],
      ['Australia/Sydney', '2026-05-31T23:00:00.000Z'],
      ['America/New_York', '2026-06-01T13:00:00.000Z'],
      ['Europe/London', '2026-06-01T08:00:00.000Z'],
    ] as const;
    for (const pass of [1, 2])
      for (const [zone, instant] of expected)
        expect(publishInstantFor('2026-06-01', '09:00', zone), `pass ${pass}, ${zone}`).toBe(
          instant,
        );
  });

  /**
   * The gap and the repeated hour again in a southern-hemisphere zone, where the transitions run
   * the other way round: Sydney loses 02:00–03:00 on 4 October 2026 and repeats 02:00–03:00 on
   * 5 April, so the first of the two 02:30s is the one still on daylight time.
   */
  it('refuses a gap and takes the earlier repeated instant south of the equator too', () => {
    expect(() => publishInstantFor('2026-10-04', '02:30', 'Australia/Sydney')).toThrow(
      /does not exist/,
    );
    expect(publishInstantFor('2026-04-05', '02:30', 'Australia/Sydney')).toBe(
      '2026-04-04T15:30:00.000Z',
    );
  });

  it('refuses a zone that does not exist rather than scanning for it', () => {
    expect(() => publishInstantFor('2026-06-01', '09:00', 'Mars/Olympus_Mons')).toThrow(RangeError);
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
    await expect(
      provider.uploadMedia({
        name: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        body: (async function* () {
          yield new Uint8Array([1]);
        })(),
      }),
    ).rejects.toThrow('Publishing is off.');
    await expect(provider.describe('missing')).rejects.toThrow('Publishing is off.');
    await expect(
      provider.update('missing', {
        caption: '',
        mediaUrls: [],
        scheduledInstant: '',
        timezone: '',
        targets: [],
      }),
    ).rejects.toThrow('Publishing is off.');
  });
});

describe('Drive media submission', () => {
  const serviceFor = (provider: MockPublishProvider, drive: MockDriveMediaProvider) =>
    new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
      drive,
    );

  it('refuses mixed Drive and public sources during preview by name', () => {
    const id = 'drive-media-file-mixed';
    const publicUrl = 'https://cdn.example.com/public.png';
    const plan = buildPublishPlan(
      add({
        channels: ['x'],
        media: [
          driveDescriptor(id),
          {
            source: 'URL',
            url: publicUrl,
            driveFileId: null,
            driveName: null,
            mimeType: null,
            sizeBytes: null,
            driveVersion: null,
            driveModifiedAt: null,
            driveChecksum: null,
            driveVerifiedAt: null,
          },
        ],
        format: 'CAROUSEL',
      }),
      targets,
      'America/New_York',
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(plan.refusals.join(' ')).toContain(`${id}.png`);
    expect(plan.refusals.join(' ')).toContain(publicUrl);
    expect(plan.request).toBeUndefined();
  });

  /**
   * The one media role C73 actually verified, end to end.
   *
   * §14 question 3 records it: `POST` accepted an `application/pdf` asset by id together with
   * `linkedin.document_title`, and the read-back kept the configuration. So it is **not** a role row
   * — it is the ordinary C75 upload plus the title override this app has always had, and what C76
   * owed it was a test that walks the whole path rather than a new column. From the Drive PDF through
   * revalidation, the bounded stream, the provider media id, and the tailored configuration, to the
   * vendor field name.
   */
  it('publishes a Drive PDF to LinkedIn as a document post with its title', async () => {
    const id = 'drive-media-file-pdf';
    const linkedin = [
      { id: 7, platform: 'linkedin', handle: '@gholmes-designs', name: 'G.Holmes Designs' },
    ];
    const post = add({
      channels: ['li'],
      media: [
        {
          ...driveDescriptor(id, 622),
          driveName: 'q3-report.pdf',
          mimeType: 'application/pdf',
        },
      ],
      format: 'IMAGE',
    });
    await replacePostVariants(db, post.id, {
      variants: [{ platform: 'linkedin', accountId: null, title: 'Q3 report' }],
    });
    const provider = new MockPublishProvider(linkedin);
    const drive = new MockDriveMediaProvider();
    drive.seed(id, { name: 'q3-report.pdf', mimeType: 'application/pdf', size: '622' });
    drive.seedBody(id, new Uint8Array(622));
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
      drive,
    );

    const preview = await service.preview(post.id);
    expect(preview.refusals).toEqual([]);
    // A PDF on its own is a document post on LinkedIn, and the title is the thing that names it.
    expect(reportFor(preview, 'li')).toMatchObject({ status: 'READY', kind: 'POST' });
    expect(reportFor(preview, 'li').content?.title).toBe('Q3 report');

    await service.submit(post.id, preview.planHash);
    expect(provider.uploads).toEqual([
      { name: 'q3-report.pdf', mimeType: 'application/pdf', sizeBytes: 622, bytesRead: 622 },
    ]);
    const submission = provider.submissions[0] as PublishRequest;
    expect(submission).toMatchObject({
      mediaIds: ['mock-media-1'],
      platformConfigurations: [{ platform: 'linkedin', title: 'Q3 report' }],
    });
    expect(submission.mediaUrls).toBeUndefined();
    // And the vendor's own field name, from the builder the live adapter calls.
    expect(postBridgePlatformConfigurations(submission)).toEqual({
      linkedin: { document_title: 'Q3 report' },
    });
  });

  it('revalidates, streams, submits media ids only, and stores versioned evidence', async () => {
    const id = 'drive-media-file-001';
    const post = add({ channels: ['x'], media: [driveDescriptor(id)], format: 'IMAGE' });
    const provider = new MockPublishProvider(targets);
    const drive = new MockDriveMediaProvider();
    drive.seed(id, { size: '4' });
    drive.seedBody(id, new Uint8Array([1, 2]), new Uint8Array([3, 4]));
    const service = serviceFor(provider, drive);

    const preview = await service.preview(post.id);
    expect(preview.refusals).toEqual([]);
    expect(preview.request).toMatchObject({ mediaIds: [] });
    const publication = await service.submit(post.id, preview.planHash);

    expect(provider.uploads).toEqual([
      { name: `${id}.png`, mimeType: 'image/png', sizeBytes: 4, bytesRead: 4 },
    ]);
    expect(provider.submissions[0]).toMatchObject({ mediaIds: ['mock-media-1'] });
    expect(provider.submissions[0]).not.toHaveProperty('mediaUrls');
    expect(publication.sentProviderMediaIds).toEqual(['mock-media-1']);
    expect(publication.sentMediaSources).toEqual({ version: 1, items: [driveDescriptor(id)] });
  });

  it('writes no publication and no provider post when the fingerprint changed', async () => {
    const id = 'drive-media-file-002';
    const post = add({ channels: ['x'], media: [driveDescriptor(id)], format: 'IMAGE' });
    const provider = new MockPublishProvider(targets);
    const drive = new MockDriveMediaProvider();
    drive.seed(id, { size: '4' });
    const service = serviceFor(provider, drive);
    const preview = await service.preview(post.id);
    drive.seed(id, { size: '4', version: '8' });

    await expect(service.submit(post.id, preview.planHash)).rejects.toThrow(/changed after/);
    expect(provider.uploads).toEqual([]);
    expect(provider.submissions).toEqual([]);
    expect(service.list(post.id)).toEqual([]);
    expect(listIntegrationEvents(db)[0]).toMatchObject({ outcome: 'FAILURE' });
  });

  it('records a partial event and no publication when a later upload fails', async () => {
    const first = 'drive-media-file-003';
    const second = 'drive-media-file-004';
    const post = add({
      channels: ['x'],
      media: [driveDescriptor(first), driveDescriptor(second)],
      format: 'CAROUSEL',
    });
    const provider = new MockPublishProvider(targets);
    provider.uploadFailureAt = 2;
    const drive = new MockDriveMediaProvider();
    for (const id of [first, second]) {
      drive.seed(id, { size: '4' });
      drive.seedBody(id, new Uint8Array(4));
    }
    const service = serviceFor(provider, drive);
    const preview = await service.preview(post.id);

    await expect(service.submit(post.id, preview.planHash)).rejects.toThrow(/Media upload failed/);
    expect(provider.submissions).toEqual([]);
    expect(service.list(post.id)).toEqual([]);
    expect(listIntegrationEvents(db)[0]).toMatchObject({ outcome: 'PARTIAL' });
  });

  it('re-uploads fresh provider ids for content updates and restore-and-resubmit', async () => {
    const id = 'drive-media-file-reupload';
    const post = add({ channels: ['x'], media: [driveDescriptor(id)], format: 'IMAGE' });
    const provider = new MockPublishProvider(targets);
    const drive = new MockDriveMediaProvider();
    drive.seed(id, { size: '4' });
    drive.seedBody(id, new Uint8Array(4));
    const service = serviceFor(provider, drive);

    const firstPlan = await service.preview(post.id);
    const first = await service.submit(post.id, firstPlan.planHash);
    db.prepare('UPDATE signal_posts SET text=? WHERE id=?').run('Updated once', post.id);
    const updatePreview = await service.providerPreview(first.id);
    const updated = await service.applyProviderAction(
      first.id,
      'UPDATE_CONTENT',
      updatePreview.reconcileHash,
    );

    expect(provider.uploads).toHaveLength(2);
    expect(provider.updates[0]?.request).toMatchObject({ mediaIds: ['mock-media-2'] });
    expect(updated.sentProviderMediaIds).toEqual(['mock-media-2']);

    db.prepare('UPDATE signal_posts SET text=? WHERE id=?').run('Updated twice', post.id);
    const restorePreview = await service.providerPreview(first.id);
    const restored = await service.applyProviderAction(
      first.id,
      'RESTORE_AND_RESUBMIT',
      restorePreview.reconcileHash,
    );
    expect(provider.uploads).toHaveLength(3);
    expect(provider.submissions.at(-1)).toMatchObject({ mediaIds: ['mock-media-3'] });
    expect(restored.id).not.toBe(first.id);
    expect(restored.sentProviderMediaIds).toEqual(['mock-media-3']);
  });

  it('reports unavailable provider media evidence and refuses schedule-only reconciliation', async () => {
    const id = 'drive-media-file-unavailable';
    const post = add({ channels: ['x'], media: [driveDescriptor(id)], format: 'IMAGE' });
    const provider = new MockPublishProvider(targets);
    const drive = new MockDriveMediaProvider();
    drive.seed(id, { size: '4' });
    drive.seedBody(id, new Uint8Array(4));
    const service = serviceFor(provider, drive);
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);
    provider.record = { ...provider.record, mediaIds: undefined };
    db.prepare('UPDATE signal_posts SET time=? WHERE id=?').run('15:30', post.id);

    const comparison = await service.providerPreview(publication.id);
    expect(comparison.diffs.find((diff) => diff.field === 'media')).toMatchObject({
      changed: false,
      comparisonAvailable: false,
    });
    expect(comparison.warnings.join(' ')).toMatch(/Media comparison unavailable/);
    expect(providerActionOffer(comparison, 'UPDATE_SCHEDULE')?.available).toBe(false);
    expect(providerActionOffer(comparison, 'UPDATE_SCHEDULE')?.refusals.join(' ')).toMatch(
      /Media comparison unavailable/,
    );
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
    { id: 9, platform: 'threads', handle: '@gholmes', name: 'G.Holmes Designs' },
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
    for (const channel of ['x', 'bsky', 'li', 'fb', 'yt', 'tt', 'th'] as const)
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
      expect.stringContaining('could not be classified from what is recorded about it'),
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
    const events = listIntegrationEvents(db, { correlationId: publication.id });
    expect(events.filter((event) => event.operation === 'signal.publish')).toHaveLength(1);
    expect(events.filter((event) => event.operation === 'signal.reconcile')).toHaveLength(1);
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
    expect(provider.checks).toHaveLength(0);
    expect(publication.error).not.toContain('do-not-store');
  });

  it('records an answered provider failure as FAILED and keeps publication history on hard-delete refusal', async () => {
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
    expect(provider.checks).toHaveLength(0);
    expect(() => deletePost(db, post.id)).toThrow(/history protects/);
    expect(getPost(db, post.id)?.lifecycle).toBe('ACTIVE');
    await expect(service.reconcile('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('reconciles automatically after an answered submit and leaves a rate-limited follow-up alone', async () => {
    const post = add();
    const provider = new MockPublishProvider(targets);
    provider.checkResult = {
      providerPostId: 'mock-publication',
      state: 'CONFIRMED',
      targets: [{ accountId: 1, outcome: 'SUCCESS', permalink: 'https://example.com/post' }],
    };
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01'),
    );
    const answered = await service.submit(post.id, (await service.preview(post.id)).planHash);
    expect(answered.state).toBe('CONFIRMED');
    expect(answered.checkedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(answered.targets[0]).toMatchObject({
      outcome: 'SUCCESS',
      permalink: 'https://example.com/post',
    });
    expect(provider.checks).toEqual(['mock-publication']);
    expect(db.prepare('SELECT status FROM signal_posts WHERE id=?').get(post.id)).toEqual({
      status: 'DRAFT',
    });

    const rateLimited = add({ text: 'Rate limited follow-up' });
    const limited = new MockPublishProvider(targets);
    limited.check = async (providerPostId: string) => {
      limited.checks.push(providerPostId);
      throw new PublishProviderError('slow down', false, {
        rateLimited: true,
        retryAfterSeconds: 30,
      });
    };
    const limitedService = new PublishService(
      db,
      new LocalSignalProvider(db),
      limited,
      'America/New_York',
      () => new Date('2026-01-01'),
    );
    const held = await limitedService.submit(
      rateLimited.id,
      (await limitedService.preview(rateLimited.id)).planHash,
    );
    expect(held.state).toBe('SUBMITTED');
    expect(held.checkedAt).toBeUndefined();
    expect(limited.checks).toEqual(['mock-publication']);
    expect(limited.submissions).toHaveLength(1);
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
    expect(deliveryTargetSummary({ state: 'SUBMITTED' }, target({ outcome: 'SUCCESS' }))).toEqual({
      label: PUBLICATION_STATE_LABEL.SUBMITTED,
      group: 'IN_FLIGHT',
    });
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

  it('treats an immediate send as due on the first automatic check', () => {
    expect(
      reconcileSchedule(
        publication({ scheduledInstant: null }),
        new Date('2026-09-14T12:00:00.000Z'),
      ),
    ).toEqual({ dueAt: undefined, due: true, exhausted: false });
  });

  it('admits a clearly answered submit into reconcile and refuses ambiguous ones', () => {
    expect(
      shouldReconcileAfterSubmit({
        state: 'SUBMITTED',
        providerPostId: 'provider-1',
        targets: [],
      }),
    ).toBe(true);
    expect(
      shouldReconcileAfterSubmit({
        state: 'SUBMITTED',
        providerPostId: undefined,
        targets: [],
      }),
    ).toBe(false);
    expect(
      shouldReconcileAfterSubmit({
        state: 'UNCONFIRMED',
        providerPostId: undefined,
        targets: [],
      }),
    ).toBe(false);
    expect(
      shouldReconcileAfterSubmit({
        state: 'FAILED',
        providerPostId: undefined,
        targets: [],
      }),
    ).toBe(false);
    expect(
      shouldReconcileAfterSubmit({
        state: 'SUBMITTED',
        providerPostId: 'provider-1',
        targets: [
          {
            channel: 'tt',
            platform: 'tiktok',
            accountId: 1,
            handle: '@a',
            mode: 'AUTOMATIC',
            error: 'connection ended without an answer',
          },
        ],
      }),
    ).toBe(false);
    expect(
      shouldReconcileAfterSubmit({
        state: 'PARTIAL',
        providerPostId: undefined,
        targets: [
          {
            channel: 'tt',
            platform: 'tiktok',
            accountId: 1,
            handle: '@a',
            mode: 'AUTOMATIC',
            outcome: 'SUCCESS',
            remotePostId: 'buf-1',
          },
          {
            channel: 'yt',
            platform: 'youtube',
            accountId: 2,
            handle: '@b',
            mode: 'AUTOMATIC',
            error: 'connection ended without an answer',
          },
        ],
      }),
    ).toBe(false);
    expect(
      shouldReconcileAfterSubmit({
        state: 'PARTIAL',
        providerPostId: undefined,
        targets: [
          {
            channel: 'tt',
            platform: 'tiktok',
            accountId: 1,
            handle: '@a',
            mode: 'AUTOMATIC',
            outcome: 'SUCCESS',
            remotePostId: 'buf-1',
          },
          {
            channel: 'yt',
            platform: 'youtube',
            accountId: 2,
            handle: '@b',
            mode: 'AUTOMATIC',
            outcome: 'FAILURE',
            error: 'refused',
          },
        ],
      }),
    ).toBe(false);
    expect(
      shouldReconcileAfterSubmit({
        state: 'SUBMITTED',
        providerPostId: undefined,
        targets: [
          {
            channel: 'tt',
            platform: 'tiktok',
            accountId: 1,
            handle: '@a',
            mode: 'AUTOMATIC',
            outcome: 'SUCCESS',
            remotePostId: 'buf-1',
          },
        ],
      }),
    ).toBe(true);
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
      {
        channel: 'x',
        platform: 'twitter',
        accountId: 1,
        provider: 'post-bridge',
        accountRef: '1',
        handle: '@gholmes',
        mode: 'AUTOMATIC',
      },
    ]);
    expect(reportFor(preview, 'blog').mode).toBe('UNSUPPORTED');

    const publication = await service.submit(post.id, preview.planHash);
    expect(publication.targets).toEqual([
      {
        channel: 'x',
        platform: 'twitter',
        accountId: 1,
        provider: 'post-bridge',
        accountRef: '1',
        handle: '@gholmes',
        mode: 'AUTOMATIC',
      },
    ]);
    expect(publication.checkAttempts).toBe(0);
    expect(publication.checkedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(provider.checks).toEqual(['mock-publication']);

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
    expect(provider.checks).toEqual(['mock-publication']);

    // Before the publishing instant an automatic check is answered from storage, with no further call.
    const early = await service.reconcile(publication.id, { automatic: true });
    expect(provider.checks).toEqual(['mock-publication']);
    expect(early.checkAttempts).toBe(0);

    // A person asking is never held to that schedule, and never spends an attempt either.
    const manual = await service.reconcile(publication.id);
    expect(provider.checks).toEqual(['mock-publication', 'mock-publication']);
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

    // An automatic check that is not due costs the provider nothing beyond the post-submit read.
    await request(app)
      .post(`/api/signal/publications/${submitted.body.id}/reconcile`)
      .send({ automatic: true })
      .expect(200);
    expect(provider.checks).toEqual(['mock-publication']);
    expect(submitted.body.checkedAt).toBeTruthy();

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

    // C73 verified the same generic story path against Facebook. Keep this fixture separate from
    // Instagram's media-bound assertions: the regression it owns is that Facebook reaches the
    // provider as a story without a Facebook-only production branch.
    const facebookStory = plan(
      add({ channels: ['fb'], mediaUrls: ['https://cdn.example.com/a.jpg'] }),
      [{ platform: 'facebook', accountId: null, postKind: 'STORY' }],
    );
    expect(publishPreviewRefusals(facebookStory)).toEqual([]);
    expect(reportFor(facebookStory, 'fb')).toMatchObject({ kind: 'STORY', status: 'READY' });
    expect(facebookStory.request?.platformConfigurations).toEqual([
      { platform: 'facebook', story: true },
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
    await replacePostVariants(db, post.id, {
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

  it('replaces the whole set and drops a layer that overrides nothing', async () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    await replacePostVariants(db, post.id, {
      variants: [
        { platform: 'twitter', accountId: null, caption: 'First' },
        { platform: 'linkedin', accountId: null, caption: 'Second' },
      ],
    });
    const replaced = await replacePostVariants(db, post.id, {
      variants: [
        { platform: 'twitter', accountId: null, caption: '   ' },
        { platform: 'linkedin', accountId: null, caption: 'Still here' },
      ],
    });
    expect(replaced.map((variant) => variant.platform)).toEqual(['linkedin']);
    expect(replaced[0]).toMatchObject({ caption: 'Still here', accountId: null });
  });

  it('keeps an empty media selection apart from no selection across the round trip', async () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    const stored = await replacePostVariants(db, post.id, {
      variants: [
        { platform: 'twitter', accountId: null, mediaUrls: [] },
        { platform: 'linkedin', accountId: null, caption: 'No selection here' },
      ],
    });
    expect(stored.find((v) => v.platform === 'twitter')?.mediaUrls).toEqual([]);
    expect(stored.find((v) => v.platform === 'linkedin')?.mediaUrls).toBeUndefined();
  });

  it('refuses a field the platform does not carry, and media the post does not have', async () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    await expect(
      replacePostVariants(db, post.id, {
        variants: [{ platform: 'bluesky', accountId: null, title: 'Nowhere' }],
      }),
    ).rejects.toThrow(/Bluesky takes no title/);
    // A role the provider defines no field for at all. Bluesky has neither, so neither can be
    // stored against it; YouTube's thumbnail and Instagram's cover are the two the provider names,
    // and those are stored and warned about rather than refused.
    await expect(
      replacePostVariants(db, post.id, {
        variants: [
          {
            platform: 'bluesky',
            accountId: null,
            thumbnail: { source: 'URL', url: 'https://x.test/t.jpg' },
          },
        ],
      }),
    ).rejects.toThrow(/Bluesky takes no thumbnail/);
    await expect(
      replacePostVariants(db, post.id, {
        variants: [{ platform: 'twitter', accountId: null, mediaUrls: ['https://x.test/new.jpg'] }],
      }),
    ).rejects.toThrow(/media the post already carries/);
    await expect(
      replacePostVariants(db, post.id, {
        variants: [{ platform: 'twitter', accountId: null, postKind: 'STORY' }],
      }),
    ).rejects.toThrow(/X does not accept a story/);
    // A role the provider does name, refused on its own contents rather than on the platform: a
    // cover is a still image, and a video in the role would be refused at the wire.
    await expect(
      replacePostVariants(db, post.id, {
        variants: [
          {
            platform: 'instagram',
            accountId: null,
            coverImage: { source: 'URL', url: 'https://cdn.example.com/clip.mp4' },
          },
        ],
      }),
    ).rejects.toThrow(/cover image has to be an image/);
  });

  it('answers the routes, refuses a bad layer with a 400, and goes with the post', async () => {
    const post = add({ channels: ['x'], mediaUrls: media });
    await request(app())
      .put(`/api/signal/posts/${post.id}/variants`)
      .send({
        variants: [{ platform: 'twitter', accountId: null, caption: 'The short version' }],
        revision: post.revision,
      })
      .expect(200)
      .expect((response) => expect(response.body[0].caption).toBe('The short version'));
    await request(app())
      .get(`/api/signal/posts/${post.id}/variants`)
      .expect(200)
      .expect((response) => expect(response.body).toHaveLength(1));
    await request(app())
      .put(`/api/signal/posts/${post.id}/variants`)
      .send({ variants: [{ platform: 'bluesky', accountId: null, title: 'Nowhere' }], revision: 2 })
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
    await replacePostVariants(db, post.id, {
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

/**
 * Updating, rescheduling, and withdrawing a post the provider is already holding.
 *
 * The card behind these cases opened on a question rather than a plan: the interface had
 * `listTargets`, `submit`, `check`, and `cancel`, and nothing established that Post Bridge had an
 * update path at all. It does — `PATCH /v1/posts/{id}` — and the shape of everything below follows
 * from two things it says. First, a post keeps its id and its permalinks across an update, so these
 * are edits to one publication rather than a cancel-and-resubmit that loses both. Second, the
 * vendor processes a scheduled post **immediately** when an update omits `scheduled_at`, which is
 * why every request on the wire here carries one and why a test asserts that it does.
 */
describe('a post the provider is already holding', () => {
  const serviceAt = (provider: MockPublishProvider, instant = '2026-01-01T00:00:00.000Z') =>
    new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date(instant),
    );

  /** Submits a post and hands back everything a reconciliation case needs to act on it. */
  const submitted = async (overrides: Parameters<typeof add>[0] = {}) => {
    const post = add({ channels: ['x'], ...overrides });
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider);
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);
    return { post, provider, service, publication };
  };

  /** A Signal edit, written the way the app writes one — the post row and nothing else. */
  const editPost = (
    id: string,
    changes: { text?: string; date?: string | null; time?: string },
  ) => {
    if (changes.text !== undefined)
      db.prepare('UPDATE signal_posts SET text=? WHERE id=?').run(changes.text, id);
    if (changes.date !== undefined)
      db.prepare('UPDATE signal_posts SET date=? WHERE id=?').run(changes.date, id);
    if (changes.time !== undefined)
      db.prepare('UPDATE signal_posts SET time=? WHERE id=?').run(changes.time, id);
  };

  it('raises Provider update required on a Signal edit and mutates nothing remotely', async () => {
    const { post, provider, service, publication } = await submitted();
    expect(publication.driftFields).toBeUndefined();

    editPost(post.id, { text: 'A rewritten campaign post' });

    const [drifted] = service.list(post.id);
    expect(drifted?.driftFields).toEqual(['caption']);
    // The whole criterion, stated as the two call logs that would have to be non-empty for it to
    // be false. Reading the drift is local arithmetic; nothing was asked of the provider and
    // nothing was done to it.
    expect(provider.describes).toEqual([]);
    expect(provider.updates).toEqual([]);
    expect(provider.cancels).toEqual([]);
    // Nor did the snapshot move: the publication still says what actually went out.
    expect(drifted?.sentCaption).toBe('A clear campaign post');
  });

  it('reports a reschedule and a post pulled back into the queue as schedule drift', async () => {
    const { post, service } = await submitted();
    editPost(post.id, { time: '15:30' });
    expect(service.list(post.id)[0]?.driftFields).toEqual(['schedule']);

    // A live submission whose post has lost its date is a disagreement the instant comparison
    // cannot see, because there is no instant left on the Signal side to compare.
    editPost(post.id, { date: null });
    expect(service.list(post.id)[0]?.driftFields).toEqual(['schedule']);
  });

  it('previews the difference without writing anywhere, and offers only what applies', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });

    const preview = await service.providerPreview(publication.id);
    expect(preview.record?.state).toBe('SCHEDULED');
    expect(preview.changed).toEqual(['caption']);
    expect(preview.diffs.find((diff) => diff.field === 'caption')).toMatchObject({
      changed: true,
      local: 'A rewritten campaign post',
      remote: 'A clear campaign post',
    });
    // Reading is allowed; writing is not. One describe, no update, no cancel.
    expect(provider.describes).toEqual([publication.providerPostId]);
    expect(provider.updates).toEqual([]);
    expect(provider.cancels).toEqual([]);
    expect(
      db.prepare('SELECT sent_caption FROM signal_publications WHERE id=?').get(publication.id),
    ).toMatchObject({ sent_caption: 'A clear campaign post' });

    const offer = (action: ProviderAction) => providerActionOffer(preview, action);
    expect(offer('UPDATE_CONTENT')?.available).toBe(true);
    // Nothing moved the instant, so there is nothing for a schedule update to do and it says so
    // rather than offering a request that would change nothing.
    expect(offer('UPDATE_SCHEDULE')?.available).toBe(false);
    expect(offer('UPDATE_SCHEDULE')?.refusals.join(' ')).toMatch(/already on this instant/);
    expect(offer('CANCEL')?.available).toBe(true);
    expect(offer('RESTORE_AND_RESUBMIT')?.available).toBe(true);
  });

  it('sends the whole post on a content update, scheduled_at included, and keeps the provider id', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });
    const preview = await service.providerPreview(publication.id);

    const updated = await service.applyProviderAction(
      publication.id,
      'UPDATE_CONTENT',
      preview.reconcileHash,
    );

    expect(provider.updates).toHaveLength(1);
    const sent = provider.updates[0];
    expect(sent?.providerPostId).toBe(publication.providerPostId);
    expect(sent?.request.caption).toBe('A rewritten campaign post');
    // The sharpest edge on this endpoint: omitting `scheduled_at` publishes a scheduled post
    // immediately, so it is always on the wire and it is the instant the provider already had.
    expect(sent?.request.scheduledInstant).toBe(publication.scheduledInstant);
    // One publication throughout. An update is not a resubmission.
    expect(updated.id).toBe(publication.id);
    expect(updated.providerPostId).toBe(publication.providerPostId);
    expect(service.list(post.id)).toHaveLength(1);
    // The snapshot caught up, so the drift it was raised for is gone.
    expect(updated.sentCaption).toBe('A rewritten campaign post');
    expect(updated.driftFields).toBeUndefined();
  });

  it('is idempotent by end state: the same update twice leaves the same post', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });

    const first = await service.providerPreview(publication.id);
    await service.applyProviderAction(publication.id, 'UPDATE_CONTENT', first.reconcileHash);
    const after = { ...provider.record };

    // Applying the same intent again is refused as a no-op rather than sent twice — and had it
    // been sent, the full-state request would have left the record exactly as it is.
    const second = await service.providerPreview(publication.id);
    expect(providerActionOffer(second, 'UPDATE_CONTENT')?.refusals.join(' ')).toMatch(
      /already has this caption/,
    );
    expect(provider.record).toEqual(after);
    expect(provider.updates).toHaveLength(1);
  });

  it('moves the instant without carrying an unreviewed caption out with it', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post', time: '15:30' });

    const preview = await service.providerPreview(publication.id);
    expect(preview.changed).toEqual(['caption', 'schedule']);

    const updated = await service.applyProviderAction(
      publication.id,
      'UPDATE_SCHEDULE',
      preview.reconcileHash,
    );

    const sent = provider.updates[0]?.request;
    expect(sent?.scheduledInstant).toBe('2027-08-14T19:30:00.000Z');
    // The content the provider was already holding, not the edit sitting unreviewed in Signal.
    // Two actions exist precisely so that moving a post by a day cannot rewrite it.
    expect(sent?.caption).toBe('A clear campaign post');
    expect(updated.sentCaption).toBe('A clear campaign post');
    // And the caption edit is still outstanding, still reported, still nobody's surprise.
    expect(updated.driftFields).toEqual(['caption']);
  });

  it('refuses a stale comparison at commit, on either side of it', async () => {
    const { post, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });
    const preview = await service.providerPreview(publication.id);

    // Signal moves after the comparison was taken.
    editPost(post.id, { text: 'A third caption entirely' });
    await expect(
      service.applyProviderAction(publication.id, 'UPDATE_CONTENT', preview.reconcileHash),
    ).rejects.toThrow(/changed after this comparison/);
  });

  it('refuses a comparison taken before the provider moved under it', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });
    const preview = await service.providerPreview(publication.id);

    // Somebody rescheduled it in Post Bridge while the panel was open. The plan is untouched, so
    // only a token covering both sides can catch this.
    provider.record = { ...provider.record, scheduledInstant: '2027-09-01T13:00:00.000Z' };
    await expect(
      service.applyProviderAction(publication.id, 'UPDATE_CONTENT', preview.reconcileHash),
    ).rejects.toThrow(/changed after this comparison/);
    expect(provider.updates).toEqual([]);
  });

  it('keeps a published post off the scheduled-or-draft cancellation path', async () => {
    const { provider, service, publication } = await submitted();
    provider.record = { ...provider.record, state: 'PUBLISHED' };

    const preview = await service.providerPreview(publication.id);
    expect(providerActionOffer(preview, 'CANCEL')?.available).toBe(false);
    expect(providerActionOffer(preview, 'CANCEL')?.refusals.join(' ')).toMatch(
      /already published.*cannot be cancelled/i,
    );
    // Every write is refused, not only the cancellation: a published post is not ours to rewrite.
    for (const action of PROVIDER_ACTIONS)
      expect(providerActionOffer(preview, action)?.available).toBe(false);

    await expect(
      service.applyProviderAction(publication.id, 'CANCEL', preview.reconcileHash),
    ).rejects.toThrow(/already published/i);
    expect(provider.cancels).toEqual([]);
  });

  it('refuses to act on a post the provider is sending right now', async () => {
    const { provider, service, publication } = await submitted();
    provider.record = { ...provider.record, state: 'PROCESSING' };

    const preview = await service.providerPreview(publication.id);
    for (const action of PROVIDER_ACTIONS)
      expect(providerActionOffer(preview, action)?.available).toBe(false);
    expect(preview.warnings.join(' ')).toMatch(/sending this right now/);
  });

  it('cancels a scheduled post and records one redacted event beside the local update', async () => {
    const { provider, service, publication } = await submitted();
    const preview = await service.providerPreview(publication.id);

    const cancelled = await service.applyProviderAction(
      publication.id,
      'CANCEL',
      preview.reconcileHash,
    );

    expect(provider.cancels).toEqual([publication.providerPostId]);
    expect(cancelled.state).toBe('CANCELLED');
    const events = listIntegrationEvents(db, { limit: 10 });
    const event = events.find((row) => row.operation === 'signal.provider-cancel');
    expect(event).toMatchObject({ outcome: 'SUCCESS', correlationId: publication.id });
    // A cancelled publication is no longer tracking anything, so drift stops being a claim about
    // it and the comparison refuses itself rather than reading a record that is gone.
    expect(cancelled.driftFields).toBeUndefined();
    const after = await service.providerPreview(publication.id);
    expect(after.refusals.join(' ')).toMatch(/no longer holding it/);
  });

  it('withdraws and resends as a new publication, keeping the withdrawal when the resend fails', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });
    const preview = await service.providerPreview(publication.id);
    provider.failure = new PublishProviderError('Post Bridge refused the request (400).', false);

    const resent = await service.applyProviderAction(
      publication.id,
      'RESTORE_AND_RESUBMIT',
      preview.reconcileHash,
    );

    // The first external operation landed and is kept: the provider no longer holds the old post,
    // the local row says so, and the log has the row that explains it. Only the resend failed.
    expect(provider.cancels).toEqual([publication.providerPostId]);
    expect(service.get(publication.id)?.state).toBe('CANCELLED');
    expect(resent.id).not.toBe(publication.id);
    expect(resent.state).toBe('FAILED');
    expect(resent.sentCaption).toBe('A rewritten campaign post');
    const operations = listIntegrationEvents(db, { limit: 10 }).map((row) => row.operation);
    expect(operations).toContain('signal.provider-cancel');
    expect(operations).toContain('signal.publish');
    // And it is retryable: the live-publication index is free again, because the old row is
    // cancelled and the failed one is not live either.
    provider.failure = undefined;
    const retry = await service.preview(post.id);
    await expect(service.submit(post.id, retry.planHash)).resolves.toMatchObject({
      state: 'SUBMITTED',
    });
  });

  it('resends a failed provider post without asking the provider to delete it', async () => {
    const { provider, service, publication } = await submitted();
    // The vendor refuses `DELETE` on anything that is not scheduled or draft, so a failed post has
    // nothing to withdraw and asking anyway would be an error on the way to the fix.
    provider.record = { ...provider.record, state: 'FAILED' };

    const preview = await service.providerPreview(publication.id);
    expect(providerActionOffer(preview, 'RESTORE_AND_RESUBMIT')?.available).toBe(true);
    expect(providerActionOffer(preview, 'CANCEL')?.available).toBe(false);

    await service.applyProviderAction(
      publication.id,
      'RESTORE_AND_RESUBMIT',
      preview.reconcileHash,
    );
    expect(provider.cancels).toEqual([]);
    expect(service.get(publication.id)?.state).toBe('CANCELLED');
  });

  it('refuses to reschedule over content the provider was given elsewhere', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { time: '15:30' });
    // Somebody edited the post in Post Bridge itself. Rescheduling sends the content this app
    // believes is out there, which would quietly overwrite theirs — so it fails closed.
    provider.record = { ...provider.record, caption: 'Edited in Post Bridge' };

    const preview = await service.providerPreview(publication.id);
    expect(preview.warnings.join(' ')).toMatch(/holding content this app did not send/);
    expect(providerActionOffer(preview, 'UPDATE_SCHEDULE')?.available).toBe(false);
    expect(providerActionOffer(preview, 'UPDATE_SCHEDULE')?.refusals.join(' ')).toMatch(
      /Update the content from Signal/,
    );
    // Replacing their copy with Signal's is still offered — that is the deliberate choice.
    expect(providerActionOffer(preview, 'UPDATE_CONTENT')?.available).toBe(true);
  });

  it('keeps the snapshot and stays retryable when an update is refused', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });
    const preview = await service.providerPreview(publication.id);
    provider.updateFailure = new PublishProviderError('Post Bridge refused the request (400).');

    await expect(
      service.applyProviderAction(publication.id, 'UPDATE_CONTENT', preview.reconcileHash),
    ).rejects.toThrow(/refused the content update/);

    // The provider still holds the old caption, and the row still says so — which is what makes
    // the next comparison honest rather than a diff against something never sent.
    const after = service.get(publication.id) as SignalPublication;
    expect(after.sentCaption).toBe('A clear campaign post');
    expect(after.state).toBe('SUBMITTED');
    expect(after.driftFields).toEqual(['caption']);
    expect(
      listIntegrationEvents(db, { limit: 10 }).find(
        (row) => row.operation === 'signal.provider-update',
      ),
    ).toMatchObject({ outcome: 'FAILURE' });

    provider.updateFailure = undefined;
    const retry = await service.providerPreview(publication.id);
    await expect(
      service.applyProviderAction(publication.id, 'UPDATE_CONTENT', retry.reconcileHash),
    ).resolves.toMatchObject({ sentCaption: 'A rewritten campaign post' });
  });

  it('treats an unanswered update as unconfirmed rather than as a failure', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });
    const preview = await service.providerPreview(publication.id);
    provider.updateFailure = new PublishProviderError('socket hang up', true);

    await expect(
      service.applyProviderAction(publication.id, 'UPDATE_CONTENT', preview.reconcileHash),
    ).rejects.toThrow(/never answered/);

    // *We do not know* is a different fact from *it did not happen*, and only one of them is safe
    // to retry blind. The publication says so, and the log calls it partial.
    expect(service.get(publication.id)?.state).toBe('UNCONFIRMED');
    expect(
      listIntegrationEvents(db, { limit: 10 }).find(
        (row) => row.operation === 'signal.provider-update',
      ),
    ).toMatchObject({ outcome: 'PARTIAL' });
  });

  it('never writes a credential into the log or the publication row', async () => {
    const { post, provider, service, publication } = await submitted();
    editPost(post.id, { text: 'A rewritten campaign post' });
    const preview = await service.providerPreview(publication.id);
    provider.updateFailure = new PublishProviderError(
      'Post Bridge refused: Authorization: Bearer pb_live_abcdef123456 api_key=pb_secret',
    );

    await expect(
      service.applyProviderAction(publication.id, 'UPDATE_CONTENT', preview.reconcileHash),
    ).rejects.toThrow(/\[redacted\]/);

    const event = listIntegrationEvents(db, { limit: 10 }).find(
      (row) => row.operation === 'signal.provider-update',
    );
    expect(event?.error).not.toMatch(/pb_live_abcdef123456|pb_secret/);
    expect(event?.error).toMatch(/\[redacted\]/);
    expect(service.get(publication.id)?.error).not.toMatch(/pb_live_abcdef123456/);
  });

  it('explains itself when the provider cannot be read, and offers nothing', async () => {
    const { service, publication } = await submitted();
    const provider = new MockPublishProvider(targets);
    void provider;
    const failing = serviceAt(
      Object.assign(new MockPublishProvider(targets), {
        describeFailure: new PublishProviderError('connect ECONNREFUSED'),
      }),
    );
    const preview = await failing.providerPreview(publication.id);
    expect(preview.refusals.join(' ')).toMatch(/could not be read/);
    expect(preview.reconcileHash).toBe('');
    for (const action of PROVIDER_ACTIONS)
      expect(providerActionOffer(preview, action)?.available).toBe(false);
    // A comparison that produced no token cannot be committed against by any means.
    await expect(service.applyProviderAction(publication.id, 'CANCEL', '')).rejects.toThrow();
  });
});

describe('the provider reconciliation over HTTP', () => {
  it('previews, refuses a stale token, and applies an update', async () => {
    const provider = new MockPublishProvider(targets);
    const app = createApp(db, {
      publish: provider,
      publishTimezone: 'America/New_York',
      now: () => new Date('2026-01-01'),
    });
    const post = add({ channels: ['x'] });

    const planned = await request(app).post(`/api/signal/posts/${post.id}/publish/preview`).send();
    const submission = await request(app)
      .post(`/api/signal/posts/${post.id}/publish`)
      .send({ planHash: planned.body.planHash });
    expect(submission.status).toBe(201);
    const publicationId = submission.body.id as string;

    // The editor saves the whole draft, so the edit is sent the way the form sends it rather
    // than as a lone field the route would read as clearing the rest.
    const edited = await request(app)
      .patch(`/api/signal/posts/${post.id}`)
      .send({
        text: 'Rewritten in Signal',
        channels: ['x'],
        date: post.date,
        time: post.time,
        revision: post.revision,
      });
    expect(edited.status).toBe(200);

    const preview = await request(app)
      .post(`/api/signal/publications/${publicationId}/provider/preview`)
      .send();
    expect(preview.status).toBe(200);
    expect(preview.body.changed).toEqual(['caption']);
    // Nothing in the payload is a raw provider response or a credential: it is the normalized
    // record and nothing else.
    expect(JSON.stringify(preview.body)).not.toMatch(/Bearer|api_key|authorization/i);

    const stale = await request(app)
      .post(`/api/signal/publications/${publicationId}/provider/apply`)
      .send({ action: 'UPDATE_CONTENT', reconcileHash: 'a'.repeat(64) });
    expect(stale.status).toBe(409);

    const applied = await request(app)
      .post(`/api/signal/publications/${publicationId}/provider/apply`)
      .send({ action: 'UPDATE_CONTENT', reconcileHash: preview.body.reconcileHash });
    expect(applied.status).toBe(200);
    expect(applied.body.sentCaption).toBe('Rewritten in Signal');
    expect(applied.body.driftFields).toBeUndefined();
  });

  it('refuses an action the boundary does not know', async () => {
    const app = createApp(db, {
      publish: new MockPublishProvider(targets),
      publishTimezone: 'America/New_York',
      now: () => new Date('2026-01-01'),
    });
    const response = await request(app)
      .post('/api/signal/publications/whatever/provider/apply')
      .send({ action: 'DELETE_EVERYTHING', reconcileHash: 'a'.repeat(64) });
    expect(response.status).toBe(400);
  });
});

/**
 * The drift rule on its own, over the cases the service cannot reach.
 *
 * `publicationDriftFields` answers for the whole request, account set included, but the planner only
 * ever hands it the publication's own targets on both sides — it has no provider target list to
 * resolve a new one from, and reading one would make the local flag a remote call. So the account
 * comparison, and the ordering rule underneath it, are exercised here directly. The reconciliation
 * preview is the caller that does compare account sets, and it is covered against the provider.
 */
describe('the provider drift rule', () => {
  const target = (accountId: number): SignalPublicationTarget => ({
    channel: 'x',
    platform: 'twitter',
    accountId,
    handle: `@account-${accountId}`,
    mode: 'AUTOMATIC',
  });
  const sent = {
    sentCaption: 'A clear campaign post',
    sentMedia: ['https://cdn.example.com/a.jpg'],
    scheduledInstant: '2027-08-14T13:00:00.000Z',
    targets: [target(4), target(1)],
  };
  const planned = {
    caption: 'A clear campaign post',
    scheduledInstant: '2027-08-14T13:00:00.000Z',
    mediaUrls: ['https://cdn.example.com/a.jpg'],
    targets: [
      {
        channel: 'x' as const,
        platform: 'twitter',
        accountId: 1,
        handle: '@a',
        mode: 'AUTOMATIC' as const,
      },
      {
        channel: 'fb' as const,
        platform: 'facebook',
        accountId: 4,
        handle: '@b',
        mode: 'AUTOMATIC' as const,
      },
    ],
  };

  it('finds nothing when the two sides agree, whatever order the accounts arrive in', () => {
    // The provider promises no ordering, and an ordering difference is not a difference anyone
    // wants to be asked to reconcile — so both sides sort before they are compared.
    expect(publicationDriftFields(sent, planned)).toEqual([]);
  });

  it('reports an account the plan added and one it dropped', () => {
    expect(
      publicationDriftFields(sent, {
        ...planned,
        targets: [...planned.targets.slice(0, 1), { ...planned.targets[1], accountId: 9 } as never],
      }),
    ).toEqual(['accounts']);
    expect(
      publicationDriftFields(sent, { ...planned, targets: planned.targets.slice(0, 1) }),
    ).toEqual(['accounts']);
  });

  it('reports every field that moved, in one answer', () => {
    expect(
      publicationDriftFields(sent, {
        ...planned,
        caption: 'A rewritten campaign post',
        scheduledInstant: '2027-08-15T13:00:00.000Z',
        mediaUrls: [],
        targets: planned.targets.slice(0, 1),
      }),
    ).toEqual(['caption', 'schedule', 'media', 'accounts']);
  });

  it('says nothing about a schedule the plan no longer has an instant for', () => {
    // An unscheduled post has no instant to compare, and claiming the schedule "differs" from
    // nothing would be a guess. The service adds that case explicitly, from the post's own date.
    const { scheduledInstant: _dropped, ...withoutInstant } = planned;
    void _dropped;
    expect(publicationDriftFields(sent, withoutInstant)).toEqual([]);
  });
});

/**
 * The comparison's own refusals — the cases where there is nothing to compare, or nothing that
 * could be sent even if there were.
 */
describe('a provider comparison that refuses itself', () => {
  const serviceAt = (provider: MockPublishProvider) =>
    new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
    );

  it('refuses a publication whose provider id was never learned', async () => {
    const post = add({ channels: ['x'] });
    const provider = new MockPublishProvider(targets);
    // An ambiguous submit is exactly how a publication ends up live with no id: the request may
    // have arrived and there is no answer saying so.
    provider.failure = new PublishProviderError('socket hang up', true);
    const service = serviceAt(provider);
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);
    expect(publication.state).toBe('UNCONFIRMED');
    expect(publication.providerPostId).toBeUndefined();

    const preview = await service.providerPreview(publication.id);
    expect(preview.refusals.join(' ')).toMatch(/no provider id/);
    expect(preview.reconcileHash).toBe('');
    // Nothing was read, because there is nothing out there this app can name.
    expect(provider.describes).toEqual([]);
    for (const action of PROVIDER_ACTIONS)
      expect(providerActionOffer(preview, action)?.available).toBe(false);
  });

  it('repeats the plan’s own refusal instead of offering an update it could not build', async () => {
    const post = add({ channels: ['x'] });
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider);
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);

    // The post is edited into something that cannot be sent at all.
    db.prepare('UPDATE signal_posts SET text=? WHERE id=?').run('   ', post.id);

    const preview = await service.providerPreview(publication.id);
    // The reason is the publishing preview's reason, said here too: a panel that reported only
    // "no update available" would send the user looking for a cause it already knew.
    expect(providerActionOffer(preview, 'UPDATE_CONTENT')?.refusals.join(' ')).toMatch(
      /requires a caption/,
    );
    expect(providerActionOffer(preview, 'RESTORE_AND_RESUBMIT')?.refusals.join(' ')).toMatch(
      /requires a caption/,
    );
    // Withdrawing it needs no plan at all, so that one still stands — which is the whole reason
    // the actions carry their refusals separately rather than sharing one.
    expect(providerActionOffer(preview, 'CANCEL')?.available).toBe(true);
  });

  it('notices an account set the provider was given elsewhere, whatever order it reports it in', async () => {
    const post = add({ channels: ['x', 'fb'] });
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider);
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);
    // Sorted, because the channel order the post is read back in is not this assertion's subject.
    expect([...publication.targets.map((target) => target.accountId)].sort()).toEqual([1, 2]);

    // The same two accounts, reported back the other way round. Ordering is not a disagreement.
    provider.record = { ...provider.record, accountIds: [2, 1] };
    const same = await service.providerPreview(publication.id);
    expect(same.warnings.join(' ')).not.toMatch(/did not send/);
    expect(same.changed).toEqual([]);

    // A third account nobody here asked for is.
    provider.record = { ...provider.record, accountIds: [1, 2, 3] };
    const different = await service.providerPreview(publication.id);
    expect(different.changed).toEqual(['accounts']);
    expect(different.warnings.join(' ')).toMatch(/did not send/);
    expect(providerActionOffer(different, 'UPDATE_SCHEDULE')?.available).toBe(false);
    // Bringing it back to Signal's own target set is the offered way out.
    expect(providerActionOffer(different, 'UPDATE_CONTENT')?.available).toBe(true);
  });
});

/**
 * A publication written before the media snapshot existed.
 *
 * `sent_media` is nullable rather than defaulted for this case, and NULL is not `'[]'`: one is a
 * submission that carried no media on purpose, the other is a submission whose media nobody
 * recorded. Backfilling the second to the first would have made every migrated publication with
 * media report a difference it has no evidence for, so the unknown stays unknown and the one action
 * that needs the evidence is the only one refused.
 */
describe('a publication migrated from before the media snapshot', () => {
  const clear = (publicationId: string) =>
    db
      .prepare(
        'UPDATE signal_publications SET sent_media=NULL, sent_configurations=NULL, sent_media_sources=NULL, sent_provider_media_ids=NULL WHERE id=?',
      )
      .run(publicationId);

  it('claims no media difference it cannot evidence, and refuses only the reschedule', async () => {
    const post = add({ channels: ['x'], mediaUrls: ['https://cdn.example.com/a.jpg'] });
    const provider = new MockPublishProvider(targets);
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);
    clear(publication.id);

    // The post still holds its media and the snapshot no longer says what went out. Reporting
    // `media` here would send the user to reconcile something nobody can show them.
    const reread = service.get(publication.id) as SignalPublication;
    expect(reread.sentMedia).toBeUndefined();
    expect(reread.sentMediaSources).toBeUndefined();
    expect(reread.sentProviderMediaIds).toBeUndefined();
    expect(reread.driftFields).toBeUndefined();

    // Both a reschedule and a caption edit, so the reschedule's refusal can be read beside a
    // content update that is genuinely available.
    db.prepare('UPDATE signal_posts SET time=?, text=? WHERE id=?').run(
      '15:30',
      'A rewritten campaign post',
      post.id,
    );
    const preview = await service.providerPreview(publication.id);
    expect(preview.warnings.join(' ')).toMatch(/predates the media snapshot/);
    // Rescheduling is the one action that has to prove it leaves the content alone, so it is the
    // one that stops. The others do not depend on the proof.
    expect(providerActionOffer(preview, 'UPDATE_SCHEDULE')?.available).toBe(false);
    expect(providerActionOffer(preview, 'UPDATE_SCHEDULE')?.refusals.join(' ')).toMatch(
      /predates the media snapshot/,
    );
    expect(providerActionOffer(preview, 'UPDATE_CONTENT')?.available).toBe(true);
    expect(providerActionOffer(preview, 'CANCEL')?.available).toBe(true);
    expect(providerActionOffer(preview, 'RESTORE_AND_RESUBMIT')?.available).toBe(true);

    // Updating the content records a snapshot, which is what clears the refusal for good.
    const updated = await service.applyProviderAction(
      publication.id,
      'UPDATE_CONTENT',
      preview.reconcileHash,
    );
    expect(updated.sentMedia).toEqual(['https://cdn.example.com/a.jpg']);
  });
});

describe('Buffer publish planning', () => {
  const bufferTikTok: PublishTarget = {
    id: 50,
    provider: BUFFER_PROVIDER,
    accountRef: 'chan-tiktok',
    platform: 'tiktok',
    handle: '@studio',
    name: 'Studio TikTok',
    schedulingType: 'notification',
  };
  const bufferAutomatic: PublishTarget = {
    ...bufferTikTok,
    id: 60,
    schedulingType: 'automatic',
  };

  it('refuses Drive media for Buffer before confirmation', () => {
    const media = driveDescriptor('buffer-drive');
    const plan = buildPublishPlan(
      add({ channels: ['tt'], media: [media], mediaUrls: [media.url] }),
      [bufferTikTok],
      'America/New_York',
      new Date('2026-01-01'),
    );
    expect(reportFor(plan, 'tt').refusals.some((refusal) => refusal.includes('Drive'))).toBe(true);
    expect(reportFor(plan, 'tt').bufferWire).toBeUndefined();
    expect(plan.request).toBeUndefined();
  });

  it('marks a Buffer target driveOverridable without accepting the override', () => {
    const media = driveDescriptor('buffer-drive-flag');
    const plan = buildPublishPlan(
      add({ channels: ['tt'], media: [media], mediaUrls: [media.url] }),
      [bufferAutomatic],
      'America/New_York',
      new Date('2026-01-01'),
      [],
      [{ channel: 'tt', providerAccountId: 60 }],
    );
    expect(reportFor(plan, 'tt').driveOverridable).toBe(true);
    expect(reportFor(plan, 'tt').refusals.some((refusal) => refusal.includes('Drive'))).toBe(true);
  });

  it('sends Drive media to Buffer as a direct-download link under the override', () => {
    const media = driveDescriptor('buffer-drive-override');
    const plan = buildPublishPlan(
      add({ channels: ['tt'], media: [media], mediaUrls: [media.url] }),
      [bufferAutomatic],
      'America/New_York',
      new Date('2026-01-01'),
      [],
      [{ channel: 'tt', providerAccountId: 60 }],
      true,
    );
    const report = reportFor(plan, 'tt');
    expect(report.refusals).toEqual([]);
    expect(report.bufferWire?.assets).toEqual([
      { image: { url: `https://drive.google.com/uc?export=download&id=${media.driveFileId}` } },
    ]);
    expect(report.warnings.some((warning) => warning.includes('direct-download'))).toBe(true);
  });

  it('changes the plan hash when the Drive override is toggled', () => {
    const media = driveDescriptor('buffer-drive-hash');
    const post = add({ channels: ['tt'], media: [media], mediaUrls: [media.url] });
    const targets = [bufferAutomatic];
    const selections = [{ channel: 'tt' as SignalChannel, providerAccountId: 60 }];
    const withoutOverride = buildPublishPlan(
      post,
      targets,
      'America/New_York',
      new Date('2026-01-01'),
      [],
      selections,
    );
    const withOverride = buildPublishPlan(
      post,
      targets,
      'America/New_York',
      new Date('2026-01-01'),
      [],
      selections,
      true,
    );
    expect(withoutOverride.planHash).not.toBe(withOverride.planHash);
  });

  it('refuses mixed Post Bridge and Buffer targets in one submission', () => {
    const plan = buildPublishPlan(
      add({
        channels: ['x', 'tt'],
        mediaUrls: ['https://cdn.example.com/a.jpg'],
      }),
      [{ id: 1, platform: 'twitter', handle: '@gholmes', name: 'G.Holmes Designs' }, bufferTikTok],
      'America/New_York',
      new Date('2026-01-01'),
      [],
      [
        { channel: 'x', providerAccountId: 1 },
        { channel: 'tt', providerAccountId: 50 },
      ],
    );
    expect(plan.refusals).toEqual(
      expect.arrayContaining([expect.stringMatching(/cannot mix Post Bridge and Buffer/i)]),
    );
  });

  it('shows automatic TikTok bufferWire for a public URL', () => {
    const url = 'https://cdn.example.com/clip.mp4';
    const plan = buildPublishPlan(
      add({ channels: ['tt'], mediaUrls: [url] }),
      [bufferAutomatic],
      'America/New_York',
      new Date('2026-01-01'),
      [],
      [{ channel: 'tt', providerAccountId: 60 }],
    );
    const report = reportFor(plan, 'tt');
    expect(report.bufferWire?.assets).toEqual([{ video: { url } }]);
    expect(plan.request).toBeUndefined();
  });
});

describe('Buffer confirmed publishing', () => {
  const rawTargets: PublishTarget[] = [
    {
      id: 0,
      provider: BUFFER_PROVIDER,
      accountRef: 'buffer-tiktok',
      platform: 'tiktok',
      handle: '@buffer-tiktok',
      name: 'TikTok',
      schedulingType: 'notification',
    },
    {
      id: 1,
      provider: BUFFER_PROVIDER,
      accountRef: 'buffer-youtube',
      platform: 'youtube',
      handle: '@buffer-youtube',
      name: 'YouTube',
      schedulingType: 'notification',
    },
  ];

  const setup = () => {
    const post = add({ channels: ['tt', 'yt'], mediaUrls: [] });
    const listed = resolveProviderAccounts(db, rawTargets, () => new Date('2026-01-01'));
    const insert = db.prepare(
      'INSERT INTO signal_post_publish_targets(post_id,channel,provider_account_id,created_at) VALUES(?,?,?,?)',
    );
    insert.run(post.id, 'tt', listed[0]?.id, '2026-01-01T00:00:00.000Z');
    insert.run(post.id, 'yt', listed[1]?.id, '2026-01-01T00:00:00.000Z');
    const buffer = new MockBufferWriteProvider();
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      new MockPublishProvider(),
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
      new MockDriveMediaProvider(),
      'post-bridge',
      buffer,
    );
    return { post, listed, buffer, service };
  };

  it('pins Signal scheduling fields and stores one exact remote id per channel', async () => {
    const { post, listed, buffer, service } = setup();
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);

    expect(buffer.creates).toHaveLength(2);
    expect(buffer.creates.every((input) => input.mode === 'customScheduled')).toBe(true);
    expect(buffer.creates.every((input) => input.needsApproval === false)).toBe(true);
    expect(buffer.creates.map((input) => input.channelId)).toEqual([
      'buffer-tiktok',
      'buffer-youtube',
    ]);
    expect(publication.provider).toBe('buffer');
    expect(publication.state).toBe('SUBMITTED');
    expect(publication.targets.map((target) => target.remotePostId)).toEqual([
      'mock-buffer-1',
      'mock-buffer-2',
    ]);
    expect(buffer.reads).toEqual(['mock-buffer-1', 'mock-buffer-2']);
    expect(publication.checkedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses Buffer at preview when production writes are closed, and never creates a publication', async () => {
    const post = add({ channels: ['tt', 'yt'], mediaUrls: [] });
    const listed = resolveProviderAccounts(db, rawTargets, () => new Date('2026-01-01'));
    const insert = db.prepare(
      'INSERT INTO signal_post_publish_targets(post_id,channel,provider_account_id,created_at) VALUES(?,?,?,?)',
    );
    insert.run(post.id, 'tt', listed[0]?.id, '2026-01-01T00:00:00.000Z');
    insert.run(post.id, 'yt', listed[1]?.id, '2026-01-01T00:00:00.000Z');
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      new MockPublishProvider(),
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
      new MockDriveMediaProvider(),
      'post-bridge',
      new UnavailableBufferWriteProvider(BUFFER_WRITE_EVIDENCE.reason),
    );

    const preview = await service.preview(post.id, listed);
    expect(publishPreviewRefusals(preview)).toEqual(
      expect.arrayContaining([BUFFER_WRITE_EVIDENCE.reason]),
    );
    await expect(service.submit(post.id, preview.planHash, listed)).rejects.toThrow(
      BUFFER_WRITE_EVIDENCE.reason,
    );
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM signal_publications WHERE post_id=?').get(post.id),
    ).toEqual({ count: 0 });
  });

  it('falls back to the evidence reason when a closed Buffer write provider omits one', async () => {
    const post = add({ channels: ['tt'], mediaUrls: [] });
    const listed = resolveProviderAccounts(db, [rawTargets[0]!], () => new Date('2026-01-01'));
    db.prepare(
      'INSERT INTO signal_post_publish_targets(post_id,channel,provider_account_id,created_at) VALUES(?,?,?,?)',
    ).run(post.id, 'tt', listed[0]?.id, '2026-01-01T00:00:00.000Z');
    const closed = {
      available: false,
      async create() {
        throw new BufferWriteError('closed', 'DEFINITE_REFUSAL');
      },
      async read() {
        throw new BufferWriteError('closed', 'DEFINITE_REFUSAL');
      },
      async edit() {
        throw new BufferWriteError('closed', 'DEFINITE_REFUSAL');
      },
      async cancel() {
        throw new BufferWriteError('closed', 'DEFINITE_REFUSAL');
      },
    };
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      new MockPublishProvider(),
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
      new MockDriveMediaProvider(),
      'post-bridge',
      closed,
    );

    const preview = await service.preview(post.id, listed);
    expect(publishPreviewRefusals(preview)).toEqual(
      expect.arrayContaining([BUFFER_WRITE_EVIDENCE.reason]),
    );
    await expect(service.submit(post.id, preview.planHash, listed)).rejects.toThrow(
      BUFFER_WRITE_EVIDENCE.reason,
    );
  });

  it('still confirms a Post Bridge plan when Buffer writes are closed', async () => {
    const post = add({
      channels: ['fb'],
      mediaUrls: ['https://cdn.example.com/a.jpg'],
    });
    const listed = resolveProviderAccounts(
      db,
      [
        {
          id: 2,
          provider: 'post-bridge',
          accountRef: '2',
          platform: 'facebook',
          handle: 'gholmesdesigns',
          name: 'G.Holmes Designs',
        },
        ...rawTargets,
      ],
      () => new Date('2026-01-01'),
    );
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      new MockPublishProvider([
        {
          id: 2,
          platform: 'facebook',
          handle: 'gholmesdesigns',
          name: 'G.Holmes Designs',
        },
      ]),
      'America/New_York',
      () => new Date('2026-01-01T00:00:00.000Z'),
      new MockDriveMediaProvider(),
      'post-bridge',
      new UnavailableBufferWriteProvider(BUFFER_WRITE_EVIDENCE.reason),
    );

    const preview = await service.preview(post.id, listed);
    expect(publishPreviewRefusals(preview)).toEqual([]);
    expect(preview.targets.every((target) => target.provider !== BUFFER_PROVIDER)).toBe(true);
    const publication = await service.submit(post.id, preview.planHash, listed);
    expect(publication.provider).toBe('post-bridge');
    expect(publication.state).toBe('SUBMITTED');
  });

  it('keeps a truthful partial result and never retries an ambiguous create', async () => {
    const { post, listed, buffer, service } = setup();
    buffer.createFailureAt = 2;
    buffer.createFailure = new BufferWriteError('connection ended without an answer', 'AMBIGUOUS');
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);

    expect(buffer.creates).toHaveLength(2);
    expect(publication.state).toBe('PARTIAL');
    expect(publication.targets[0]).toMatchObject({
      outcome: 'SUCCESS',
      remotePostId: 'mock-buffer-1',
    });
    expect(publication.targets[1]?.outcome).toBeUndefined();
    expect(publication.targets[1]?.error).toMatch(/without an answer/);
    expect(buffer.reads).toEqual([]);
  });

  it('rechecks exact remote state, edits one target, cancels another, and never moves Signal', async () => {
    const { post, listed, buffer, service } = setup();
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);
    const before = db.prepare('SELECT date,time,status FROM signal_posts WHERE id=?').get(post.id);

    db.prepare('UPDATE signal_posts SET text=?,updated_at=? WHERE id=?').run(
      'Edited Buffer copy',
      '2026-01-01T00:01:00.000Z',
      post.id,
    );
    const first = listed[0] as (typeof listed)[number];
    const content = await service.bufferTargetPreview(publication.id, first.id, listed);
    expect(providerActionOffer(content, 'UPDATE_CONTENT')?.available).toBe(true);
    await service.applyBufferTargetAction(
      publication.id,
      first.id,
      'UPDATE_CONTENT',
      content.reconcileHash,
      listed,
    );
    expect(buffer.edits.at(-1)).toMatchObject({ id: 'mock-buffer-1', text: 'Edited Buffer copy' });

    const second = listed[1] as (typeof listed)[number];
    const cancellation = await service.bufferTargetPreview(publication.id, second.id, listed);
    const updated = await service.applyBufferTargetAction(
      publication.id,
      second.id,
      'CANCEL',
      cancellation.reconcileHash,
      listed,
    );
    expect(buffer.cancels).toEqual(['mock-buffer-2']);
    expect(updated.state).toBe('PARTIAL');
    expect(db.prepare('SELECT date,time,status FROM signal_posts WHERE id=?').get(post.id)).toEqual(
      before,
    );
  });

  it('rejects a target action when Buffer moved after preview', async () => {
    const { post, listed, buffer, service } = setup();
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);
    const first = listed[0] as (typeof listed)[number];
    db.prepare('UPDATE signal_posts SET text=? WHERE id=?').run('Fresh Signal text', post.id);
    const comparison = await service.bufferTargetPreview(publication.id, first.id, listed);
    const remote = buffer.posts.get('mock-buffer-1') as NonNullable<
      ReturnType<typeof buffer.posts.get>
    >;
    buffer.posts.set('mock-buffer-1', { ...remote, allowedActions: [] });

    await expect(
      service.applyBufferTargetAction(
        publication.id,
        first.id,
        'UPDATE_CONTENT',
        comparison.reconcileHash,
        listed,
      ),
    ).rejects.toThrow(/changed after this comparison/);
    expect(buffer.edits).toEqual([]);
  });

  it('distinguishes all-definite failure, mixed refusal, and first-target ambiguity', async () => {
    {
      const { post, listed, buffer, service } = setup();
      buffer.createFailures.set(1, new BufferWriteError('quota full', 'QUOTA_REFUSAL'));
      buffer.createFailures.set(2, new BufferWriteError('bad YouTube input', 'INVALID_INPUT'));
      const preview = await service.preview(post.id, listed);
      const publication = await service.submit(post.id, preview.planHash, listed);
      expect(publication.state).toBe('FAILED');
      expect(publication.targets.every((target) => target.outcome === 'FAILURE')).toBe(true);
    }
    db.close();
    db = createDb(':memory:');
    {
      const { post, listed, buffer, service } = setup();
      buffer.createFailures.set(1, new BufferWriteError('definite refusal', 'INVALID_INPUT'));
      const preview = await service.preview(post.id, listed);
      expect((await service.submit(post.id, preview.planHash, listed)).state).toBe('PARTIAL');
    }
    db.close();
    db = createDb(':memory:');
    {
      const { post, listed, buffer, service } = setup();
      buffer.createFailures.set(1, new BufferWriteError('no answer', 'AMBIGUOUS'));
      const preview = await service.preview(post.id, listed);
      const publication = await service.submit(post.id, preview.planHash, listed);
      expect(publication.state).toBe('UNCONFIRMED');
      expect(buffer.creates).toHaveLength(1);
    }
  });

  it('maps complete Buffer reconciliation to submitted, confirmed, and failed', async () => {
    const { post, listed, buffer, service } = setup();
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);
    expect((await service.reconcile(publication.id)).state).toBe('SUBMITTED');

    for (const [id, remote] of buffer.posts)
      buffer.posts.set(id, { ...remote, state: 'PUBLISHED' });
    expect((await service.reconcile(publication.id)).state).toBe('CONFIRMED');
    for (const [id, remote] of buffer.posts) buffer.posts.set(id, { ...remote, state: 'FAILED' });
    expect((await service.reconcile(publication.id)).state).toBe('FAILED');
  });

  it('records a failed Buffer read without changing the last known delivery state', async () => {
    const { post, listed, buffer, service } = setup();
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);
    const before = service.get(publication.id);
    buffer.posts.delete('mock-buffer-2');

    await expect(service.reconcile(publication.id)).rejects.toThrow('not found');
    expect(service.get(publication.id)).toEqual(before);
    expect(
      db
        .prepare(
          "SELECT outcome FROM integration_events WHERE operation='signal.reconcile' ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ outcome: 'FAILURE' });
  });

  it('offers only returned actions, reschedules one target, and cancels all targets', async () => {
    const { post, listed, buffer, service } = setup();
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);
    db.prepare('UPDATE signal_posts SET time=? WHERE id=?').run('10:00', post.id);
    const first = listed[0] as (typeof listed)[number];
    const schedule = await service.bufferTargetPreview(publication.id, first.id, listed);
    expect(providerActionOffer(schedule, 'UPDATE_SCHEDULE')?.available).toBe(true);
    expect(providerActionOffer(schedule, 'RESTORE_AND_RESUBMIT')?.available).toBe(false);
    await service.applyBufferTargetAction(
      publication.id,
      first.id,
      'UPDATE_SCHEDULE',
      schedule.reconcileHash,
      listed,
    );
    expect(buffer.edits.at(-1)?.dueAt).toBe('2027-08-14T14:00:00.000Z');

    for (const account of listed) {
      const comparison = await service.bufferTargetPreview(publication.id, account.id, listed);
      await service.applyBufferTargetAction(
        publication.id,
        account.id,
        'CANCEL',
        comparison.reconcileHash,
        listed,
      );
    }
    expect((service.get(publication.id) as SignalPublication).state).toBe('CANCELLED');
  });

  it('refuses missing publications, targets, remote ids, and non-Buffer target previews', async () => {
    const { post, listed, service } = setup();
    await expect(service.bufferTargetPreview('missing', 1, listed)).rejects.toThrow('not found');
    const preview = await service.preview(post.id, listed);
    const publication = await service.submit(post.id, preview.planHash, listed);
    await expect(service.bufferTargetPreview(publication.id, 999, listed)).rejects.toThrow(
      'not on this publication',
    );
    db.prepare(
      'UPDATE signal_publication_targets SET remote_post_id=NULL WHERE publication_id=? AND provider_account_id=?',
    ).run(publication.id, listed[0]?.id);
    await expect(
      service.bufferTargetPreview(publication.id, listed[0]?.id ?? 0, listed),
    ).rejects.toThrow('no confirmed remote post id');

    db.prepare("UPDATE signal_publications SET provider='post-bridge' WHERE id=?").run(
      publication.id,
    );
    await expect(
      service.bufferTargetPreview(publication.id, listed[1]?.id ?? 0, listed),
    ).rejects.toThrow('not a Buffer publication');
  });
});

describe('provider-qualified delivery identity', () => {
  const serviceAt = (provider: MockPublishProvider, instant: string) =>
    new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date(instant),
    );

  it('changes the reconcile hash when a target remote post id moves', async () => {
    const post = add({ channels: ['x'] });
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider, '2026-01-01T00:00:00.000Z');
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);
    const before = await service.providerPreview(publication.id);
    db.prepare(
      `UPDATE signal_publication_targets SET remote_post_id='buffer-post:opaque'
        WHERE publication_id=? AND provider_account_id=1`,
    ).run(publication.id);
    const after = await service.providerPreview(publication.id);
    expect(after.reconcileHash).not.toBe(before.reconcileHash);
  });

  it('never checks a Buffer publication through the Post Bridge adapter', async () => {
    const post = add({ channels: ['x'] });
    const provider = new MockPublishProvider(targets);
    const service = serviceAt(provider, '2026-01-01T00:00:00.000Z');
    const plan = await service.preview(post.id);
    const publication = await service.submit(post.id, plan.planHash);
    const checksAfterSubmit = [...provider.checks];
    expect(checksAfterSubmit).toEqual(['mock-publication']);
    db.prepare("UPDATE signal_publications SET provider='buffer' WHERE id=?").run(publication.id);
    await expect(service.reconcile(publication.id)).rejects.toThrow(/cannot be queried through/);
    expect(provider.checks).toEqual(checksAfterSubmit);
  });
});

describe('Publish now', () => {
  const previousEvidence = process.env.PUBLISH_NOW_EVIDENCE;

  beforeEach(() => {
    process.env.PUBLISH_NOW_EVIDENCE = '1';
  });

  afterEach(() => {
    if (previousEvidence === undefined) delete process.env.PUBLISH_NOW_EVIDENCE;
    else process.env.PUBLISH_NOW_EVIDENCE = previousEvidence;
  });

  it('plans an immediate send with no scheduled instant on the wire', () => {
    const post = add({ channels: ['x'], date: '2099-01-01', time: '09:00' });
    const plan = buildPublishPlan(
      post,
      targets,
      'America/New_York',
      new Date('2026-01-01'),
      [],
      [],
      false,
      'now',
    );
    expect(plan.timing).toBe('now');
    expect(plan.request?.scheduledInstant).toBeNull();
    expect(publishPreviewRefusals(plan)).toEqual([]);
    expect(plan.warnings.some((warning) => warning.includes('irreversible'))).toBe(true);
  });

  it('refuses publish now when evidence is closed', () => {
    delete process.env.PUBLISH_NOW_EVIDENCE;
    const post = add({ channels: ['x'], date: '2099-01-01', time: '09:00' });
    const plan = buildPublishPlan(
      post,
      targets,
      'America/New_York',
      new Date('2026-01-01'),
      [],
      [],
      false,
      'now',
    );
    expect(publishPreviewRefusals(plan).length).toBeGreaterThan(0);
    expect(plan.request).toBeUndefined();
  });

  it('uses a different plan hash from scheduled publishing', () => {
    const post = add({ channels: ['x'], date: '2099-01-01', time: '09:00' });
    const scheduled = buildPublishPlan(post, targets, 'America/New_York', new Date('2026-01-01'));
    const now = buildPublishPlan(
      post,
      targets,
      'America/New_York',
      new Date('2026-01-01'),
      [],
      [],
      false,
      'now',
    );
    expect(now.planHash).not.toBe(scheduled.planHash);
  });

  it('submits immediately without changing planning status', async () => {
    const post = add({ channels: ['x'], date: '2099-01-01', time: '09:00', status: 'SCHEDULED' });
    const provider = new MockPublishProvider(targets);
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => new Date('2026-01-01'),
    );
    const preview = await service.previewNow(post.id);
    const publication = await service.submitNow(post.id, preview.planHash);
    expect(publication.state).toBe('SUBMITTED');
    expect(provider.submissions[0]?.scheduledInstant).toBeNull();
    expect(
      (db.prepare('SELECT status FROM signal_posts WHERE id=?').get(post.id) as { status: string })
        .status,
    ).toBe('SCHEDULED');
    expect(
      listIntegrationEvents(db).some((event) => event.operation === 'signal.publish-now'),
    ).toBe(true);
  });
});

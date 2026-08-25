import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import type { SignalProvider } from '../signal/provider.ts';
import type {
  ProviderAction,
  ProviderDiffField,
  ProviderPostRecord,
  ProviderReconcilePreview,
  PublishPreview,
  SignalPublication,
} from '../../shared/publish.ts';
import {
  deliveryModeNeedsPerson,
  isReconcilableState,
  providerActionOffer,
  PROVIDER_ACTIONS,
  publicationDriftFields,
  publicationTracksProvider,
  publishPreviewRefusals,
  reconcileSchedule,
  RECONCILE_MAX_ATTEMPTS,
} from '../../shared/publish.ts';
import { buildPublishPlan, planHash, publishInstantFor } from './plan.ts';
import { buildProviderReconcile, providerRecordNeedsWithdrawal } from './reconcile.ts';
import {
  PublishMediaUploadError,
  PublishProviderError,
  PUBLISH_RATE_LIMIT_FALLBACK_SECONDS,
  type PublishProvider,
  type PublishRequest,
  type PublishSubmission,
} from './provider.ts';
import { recordSyncHealth } from './sync-health.ts';
import { toPublication, toTarget, type PublicationRow, type TargetRow } from './rows.ts';
import { targetRowsFor } from './read.ts';
import {
  DisconnectedDriveMediaProvider,
  DriveMediaError,
  openDriveMedia,
  type DriveMediaProvider,
} from '../drive/media.ts';
import type { SignalPostMedia } from '../../shared/signal-media.ts';
import { resolveProviderAccounts } from './accounts.ts';
import { bufferConfigured } from '../config.ts';
import type { PublishTarget } from './provider.ts';
import type { PublishTiming } from '../../shared/publish-now.ts';
import { BUFFER_PROVIDER, BUFFER_WRITE_EVIDENCE } from '../../shared/buffer.ts';
import type { BufferWirePreview } from '../../shared/buffer-media.ts';
import {
  BufferWriteError,
  UnavailableBufferWriteProvider,
  type BufferCreatePostInput,
  type BufferWritePost,
  type BufferWriteProvider,
} from './buffer/write-provider.ts';

export class PublishRequestError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishRequestError';
    this.status = status;
  }
}

export class PublishService {
  private readonly db: Db;
  private readonly signal: SignalProvider;
  private readonly provider: PublishProvider;
  private readonly timezone: string;
  private readonly clock: () => Date;
  private readonly driveMedia: DriveMediaProvider;
  private readonly providerId: string;
  private readonly bufferWrite: BufferWriteProvider;
  constructor(
    db: Db,
    signal: SignalProvider,
    provider: PublishProvider,
    timezone: string,
    clock: () => Date = () => new Date(),
    driveMedia: DriveMediaProvider = new DisconnectedDriveMediaProvider(),
    providerId = 'post-bridge',
    bufferWrite: BufferWriteProvider = new UnavailableBufferWriteProvider(
      BUFFER_WRITE_EVIDENCE.reason,
    ),
  ) {
    this.db = db;
    this.signal = signal;
    this.provider = provider;
    this.timezone = timezone;
    this.clock = clock;
    this.driveMedia = driveMedia;
    this.providerId = providerId;
    this.bufferWrite = bufferWrite;
  }

  /** The reason Buffer writes are closed, when they are — preview and submit share one message. */
  private bufferWriteClosedReason(): string {
    return this.bufferWrite.unavailableReason ?? BUFFER_WRITE_EVIDENCE.reason;
  }

  /**
   * A Buffer target in the plan cannot be confirmed while production writes stay evidence-gated.
   * Saying so on the preview (not only at commit) is what keeps Confirm from offering a plan the
   * write path must refuse.
   */
  private withBufferWriteGate<T extends PublishPreview>(plan: T): T {
    if (
      this.bufferWrite.available ||
      !plan.targets.some((target) => (target.provider ?? this.providerId) === BUFFER_PROVIDER)
    ) {
      return plan;
    }
    return { ...plan, refusals: [...plan.refusals, this.bufferWriteClosedReason()] };
  }

  private bufferInputs(
    plan: PublishPreview,
  ): { target: PublishPreview['targets'][number]; input: BufferCreatePostInput }[] {
    const dueAt = plan.scheduledInstant;
    if (!dueAt) return [];
    return plan.targets.flatMap((target) => {
      if ((target.provider ?? this.providerId) !== BUFFER_PROVIDER || !target.accountRef) return [];
      const channel = plan.channels.find((entry) => entry.channel === target.channel);
      const targetReport = channel?.targets?.find((entry) => entry.accountId === target.accountId);
      const content = targetReport?.content ?? channel?.content;
      const wire = (targetReport?.bufferWire ?? channel?.bufferWire) as
        BufferWirePreview | undefined;
      if (!content || !wire) return [];
      return [
        {
          target,
          input: {
            channelId: target.accountRef,
            text: content.caption,
            dueAt,
            mode: 'customScheduled',
            needsApproval: false,
            source: 'hybrid-command-center',
            assets: wire.assets,
            ...(wire.metadata ? { metadata: wire.metadata } : {}),
          },
        },
      ];
    });
  }

  private assertProviderRoute(provider: string): void {
    if (provider !== this.providerId)
      throw new PublishRequestError(
        `This publication belongs to ${provider}; it cannot be queried through ${this.providerId}.`,
        409,
      );
  }

  async preview(
    postId: string,
    listedTargets?: readonly PublishTarget[],
    driveOverride = false,
    timing: PublishTiming = 'scheduled',
  ): Promise<PublishPreview & { request?: PublishRequest; mediaSources?: SignalPostMedia[] }> {
    const publishingConfigured = this.provider.available || bufferConfigured();
    if (!publishingConfigured || !this.timezone)
      return {
        available: false,
        postId,
        planHash: '',
        caption: '',
        targets: [],
        channels: [],
        warnings: [],
        refusals: [
          bufferConfigured()
            ? 'Publishing needs PUBLISH_TIMEZONE.'
            : 'Publishing needs POST_BRIDGE_API_KEY and PUBLISH_TIMEZONE.',
        ],
      };
    const scheduled = this.db.prepare('SELECT date FROM signal_posts WHERE id=?').get(postId) as
      { date: string | null } | undefined;
    if (!scheduled) throw new PublishRequestError('Signal post not found.', 404);
    if (!scheduled.date)
      return {
        available: true,
        postId,
        planHash: '',
        caption: '',
        targets: [],
        channels: [],
        warnings: [],
        refusals: ['An unscheduled post has no publishing instant.'],
      };
    const post = (
      await this.signal.listPosts({ from: scheduled.date, to: scheduled.date })
    ).posts.find((candidate) => candidate.id === postId);
    if (!post) throw new PublishRequestError('Signal post not found.', 404);
    // Three reads through the same read-only provider: the post, the content overrides that
    // tailor it, and the accounts a person explicitly chose for each channel. None of them can
    // write, which is what keeps the publisher unable to change a schedule it is planning from.
    return this.withBufferWriteGate(
      buildPublishPlan(
        post,
        listedTargets
          ? [...listedTargets]
          : resolveProviderAccounts(
              this.db,
              this.provider.available
                ? (await this.provider.listTargets()).filter(
                    (target) => (target.provider ?? 'post-bridge') === this.providerId,
                  )
                : [],
              this.clock,
            ),
        this.timezone,
        this.clock(),
        await this.signal.listVariants(postId),
        await this.signal.listPublishTargets(postId),
        driveOverride,
        timing,
      ),
    );
  }

  previewNow(postId: string, listedTargets?: readonly PublishTarget[], driveOverride = false) {
    return this.preview(postId, listedTargets, driveOverride, 'now');
  }

  /** Uploads Drive sources once, after the hash gate and immediately before the post operation. */
  private async prepareMedia(
    plan: PublishPreview & {
      request?: PublishRequest;
      mediaSources?: SignalPostMedia[];
      accountMediaSources?: { accountId: number; items: SignalPostMedia[] }[];
    },
    input: {
      postId: string;
      correlationId: string;
      operation: 'signal.publish' | 'signal.publish-now' | 'signal.provider-update';
    },
  ): Promise<{
    request: PublishRequest;
    sources: { version: 1; items: SignalPostMedia[] };
    providerMediaIds: string[];
  }> {
    const request = plan.request as PublishRequest;
    const sources = plan.mediaSources ?? [];
    if ('mediaUrls' in request)
      return { request, sources: { version: 1, items: sources }, providerMediaIds: [] };

    const providerMediaIds: string[] = [];
    // Per account, in the plan's order, and counted into the same `providerMediaIds` ledger as the
    // submission's own files — a partial failure has to report every asset that landed, whichever
    // level it belonged to, because they all expire on the provider's clock and not on ours.
    const accountMediaIds = new Map<number, string[]>();
    const uploadOne = async (stored: SignalPostMedia) => {
      if (stored.source !== 'DRIVE')
        throw new DriveMediaError('A Drive upload plan contained a public URL. Preview it again.');
      const source = await openDriveMedia({ stored, provider: this.driveMedia });
      const uploaded = await this.provider.uploadMedia(source);
      providerMediaIds.push(uploaded.mediaId);
      return uploaded.mediaId;
    };
    try {
      for (const stored of sources) await uploadOne(stored);
      for (const account of plan.accountMediaSources ?? []) {
        const ids: string[] = [];
        // Uploaded fresh for this account rather than reusing an id from the submission's own
        // files, even where the same Drive file appears in both. A provider media id is ephemeral
        // and belongs to one request; sharing one across two levels would make the evidence lie
        // about what was sent where.
        for (const stored of account.items) ids.push(await uploadOne(stored));
        accountMediaIds.set(account.accountId, ids);
      }
    } catch (error) {
      if (error instanceof PublishMediaUploadError) providerMediaIds.push(error.providerMediaId);
      const partial = providerMediaIds.length > 0;
      transaction(this.db, () => {
        recordIntegrationEvent(this.db, {
          source: 'signal-campaign',
          operation: input.operation,
          outcome: partial ? 'PARTIAL' : 'FAILURE',
          summary: partial
            ? `${providerMediaIds.length} provider media asset${providerMediaIds.length === 1 ? '' : 's'} landed before the post request was stopped. Post Bridge documents unattached expiry after 24 hours; that timing remains unverified, so inspect the provider if cleanup matters sooner.`
            : 'No provider media asset landed, so no post request was made.',
          entities: [{ type: 'signalPost', id: input.postId, label: plan.caption.slice(0, 80) }],
          correlationId: input.correlationId,
          error: error instanceof Error ? error.message : 'Unknown media upload failure',
        });
      });
      throw new PublishRequestError(
        error instanceof DriveMediaError
          ? error.message
          : `Media upload failed before the post request: ${redactSecrets(error instanceof Error ? error.message : 'Unknown failure')}`,
        409,
        { cause: error },
      );
    }
    const { mediaIds: _planned, ...base } = request;
    void _planned;
    const accountConfigurations = base.accountConfigurations?.map((configuration) => {
      const ids = accountMediaIds.get(configuration.accountId);
      return ids ? { ...configuration, mediaIds: ids } : configuration;
    });
    return {
      request: {
        ...base,
        ...(accountConfigurations ? { accountConfigurations } : {}),
        mediaIds: providerMediaIds,
      },
      sources: { version: 1, items: sources },
      providerMediaIds,
    };
  }

  async submit(
    postId: string,
    expectedHash: string,
    listedTargets?: readonly PublishTarget[],
    driveOverride = false,
    timing: PublishTiming = 'scheduled',
  ): Promise<SignalPublication> {
    const plan = await this.preview(postId, listedTargets, driveOverride, timing);
    // The gate is every refusal in the plan, per-channel ones included, so a reason the preview
    // showed the user can never be stepped over at commit.
    const blockers = publishPreviewRefusals(plan);
    const bufferInputs = this.bufferInputs(plan);
    const bufferOnly =
      plan.targets.length > 0 &&
      plan.targets.every((target) => (target.provider ?? this.providerId) === BUFFER_PROVIDER);
    // Evidence-closed Buffer writes are named before the generic refusal join so Confirm's error
    // stays the production-enablement reason rather than a concatenated plan dump — and so the
    // submit-time gate remains reachable after preview has already refused for the same cause.
    if (timing === 'now' && bufferOnly)
      throw new PublishRequestError(
        'Publish now is not available for Buffer targets until the immediate-create contract is verified.',
        400,
      );
    if (bufferOnly && !this.bufferWrite.available)
      throw new PublishRequestError(this.bufferWriteClosedReason(), 409);
    if (!plan.available || blockers.length || (!plan.request && !bufferOnly))
      throw new PublishRequestError(blockers.join(' ') || 'Publishing is unavailable.', 400);
    if (plan.planHash !== expectedHash)
      throw new PublishRequestError(
        'The post or provider targets changed after preview. Preview it again before submitting.',
        409,
      );
    const publishOperation = timing === 'now' ? 'signal.publish-now' : 'signal.publish';
    if (bufferOnly) {
      if (bufferInputs.length !== plan.targets.length)
        throw new PublishRequestError('A Buffer target has no complete write plan.', 400);
      return this.submitBuffer(postId, plan, bufferInputs);
    }
    const existing = this.db
      .prepare(
        "SELECT 1 FROM signal_publications WHERE post_id=? AND state IN ('SUBMITTING','SUBMITTED','UNCONFIRMED') LIMIT 1",
      )
      .get(postId);
    if (existing)
      throw new PublishRequestError(
        'This post already has a live publication. Double-submit was blocked.',
        409,
      );
    const publicationId = crypto.randomUUID();
    const prepared = await this.prepareMedia(plan, {
      postId,
      correlationId: publicationId,
      operation: publishOperation,
    });
    const request = prepared.request;
    const timestamp = this.clock().toISOString();
    try {
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO signal_publications(
          id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,sent_caption,sent_channels,sent_media,sent_configurations,sent_account_configurations,sent_media_sources,sent_provider_media_ids,error,created_at,updated_at
        ) VALUES(?,?, 'SUBMITTING',?,NULL,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
          )
          .run(
            publicationId,
            postId,
            plan.targets[0]?.provider ?? this.providerId,
            crypto.randomUUID(),
            request.scheduledInstant,
            request.timezone,
            request.caption,
            JSON.stringify(plan.targets.map((target) => target.channel)),
            // The media and the tailoring go into the snapshot beside the caption, so a later
            // comparison against the provider reads the request that was sent rather than
            // re-deriving one from a post that has since been edited.
            JSON.stringify(prepared.sources.items.map((item) => item.url)),
            JSON.stringify(request.platformConfigurations ?? []),
            // Versioned, and written even when empty: `{ items: [] }` is *nothing was tailored per
            // account*, which is a fact worth recording. NULL is reserved for rows migrated from
            // before this column existed, where the answer is genuinely unknown.
            JSON.stringify({ version: 1, items: request.accountConfigurations ?? [] }),
            JSON.stringify(prepared.sources),
            prepared.providerMediaIds.length ? JSON.stringify(prepared.providerMediaIds) : null,
            timestamp,
            timestamp,
          );
        // The handle and the delivery mode are snapshotted beside the account id for the same
        // reason the caption is: a record of what went out has to stay readable after the
        // capability table or the connected account has moved on.
        const insert = this.db.prepare(
          'INSERT INTO signal_publication_targets(publication_id,channel,provider_account_id,handle,mode) VALUES(?,?,?,?,?)',
        );
        for (const target of plan.targets)
          insert.run(publicationId, target.channel, target.accountId, target.handle, target.mode);
      });
    } catch (error) {
      if ((error as Error).message.includes('UNIQUE constraint failed')) {
        if (prepared.providerMediaIds.length)
          transaction(this.db, () => {
            recordIntegrationEvent(this.db, {
              source: 'signal-campaign',
              operation: publishOperation,
              outcome: 'PARTIAL',
              summary: `${prepared.providerMediaIds.length} provider media asset${prepared.providerMediaIds.length === 1 ? '' : 's'} landed, but a concurrent submit won the local publication lock before any post request was made. Post Bridge documents unattached expiry after 24 hours; that timing remains unverified.`,
              entities: [{ type: 'signalPost', id: postId, label: plan.caption.slice(0, 80) }],
              correlationId: publicationId,
              error: 'Concurrent double-submit was blocked after media upload.',
            });
          });
        throw new PublishRequestError(
          'This post already has a live publication. Double-submit was blocked.',
          409,
          { cause: error },
        );
      }
      throw error;
    }

    try {
      const result = await this.provider.submit(request);
      const updated = this.clock().toISOString();
      transaction(this.db, () => {
        this.db
          .prepare(
            'UPDATE signal_publications SET state=?,provider_post_id=?,error=?,updated_at=? WHERE id=?',
          )
          .run(
            result.state,
            result.providerPostId,
            result.error ? redactSecrets(result.error) : null,
            updated,
            publicationId,
          );
        for (const target of result.targets ?? []) this.recordTargetResult(publicationId, target);
        const succeeded = (result.targets ?? [])
          .filter((target) => target.outcome === 'SUCCESS')
          .map(
            (target) =>
              plan.targets.find((planned) => planned.accountId === target.accountId)?.channel,
          )
          .filter(Boolean);
        const failed = (result.targets ?? [])
          .filter((target) => target.outcome === 'FAILURE')
          .map(
            (target) =>
              plan.targets.find((planned) => planned.accountId === target.accountId)?.channel,
          )
          .filter(Boolean);
        recordIntegrationEvent(this.db, {
          source: 'signal-campaign',
          operation: publishOperation,
          outcome:
            result.state === 'PARTIAL'
              ? 'PARTIAL'
              : result.state === 'FAILED'
                ? 'FAILURE'
                : 'SUCCESS',
          summary:
            result.state === 'PARTIAL'
              ? `Published: ${succeeded.join(', ') || 'none'}. Failed: ${failed.join(', ') || 'none'}.`
              : `Publish submission ended ${result.state.toLowerCase()}.`,
          entities: [{ type: 'signalPost', id: postId, label: plan.caption.slice(0, 80) }],
          correlationId: publicationId,
          ...(result.error ? { error: result.error } : {}),
        });
      });
    } catch (error) {
      const ambiguous = error instanceof PublishProviderError && error.ambiguous;
      const state = ambiguous ? 'UNCONFIRMED' : 'FAILED';
      transaction(this.db, () => {
        this.db
          .prepare('UPDATE signal_publications SET state=?,error=?,updated_at=? WHERE id=?')
          .run(
            state,
            redactSecrets((error as Error).message),
            this.clock().toISOString(),
            publicationId,
          );
        recordIntegrationEvent(this.db, {
          source: 'signal-campaign',
          operation: publishOperation,
          outcome: ambiguous ? 'PARTIAL' : 'FAILURE',
          summary: ambiguous
            ? 'Publish result is unconfirmed; no retry was attempted.'
            : 'Publish submission failed.',
          entities: [{ type: 'signalPost', id: postId, label: plan.caption.slice(0, 80) }],
          correlationId: publicationId,
          error: (error as Error).message,
        });
      });
    }
    return this.get(publicationId) as SignalPublication;
  }

  submitNow(
    postId: string,
    expectedHash: string,
    listedTargets?: readonly PublishTarget[],
    driveOverride = false,
  ) {
    return this.submit(postId, expectedHash, listedTargets, driveOverride, 'now');
  }

  /**
   * One Buffer mutation per target, persisted in answered order. An ambiguous create stops the
   * sequence and is never retried; already answered targets remain exact and readable.
   */
  private async submitBuffer(
    postId: string,
    plan: PublishPreview,
    creates: { target: PublishPreview['targets'][number]; input: BufferCreatePostInput }[],
  ): Promise<SignalPublication> {
    const existing = this.db
      .prepare(
        "SELECT 1 FROM signal_publications WHERE post_id=? AND state IN ('SUBMITTING','SUBMITTED','UNCONFIRMED','PARTIAL') LIMIT 1",
      )
      .get(postId);
    if (existing)
      throw new PublishRequestError(
        'This post already has a live publication. Double-submit was blocked.',
        409,
      );
    const publicationId = crypto.randomUUID();
    const timestamp = this.clock().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO signal_publications(
             id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
             sent_caption,sent_channels,sent_media,sent_configurations,sent_account_configurations,
             sent_media_sources,sent_provider_media_ids,error,created_at,updated_at
           ) VALUES(?,?,'SUBMITTING',?,NULL,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)`,
        )
        .run(
          publicationId,
          postId,
          BUFFER_PROVIDER,
          crypto.randomUUID(),
          plan.scheduledInstant as string,
          plan.timezone as string,
          plan.caption,
          JSON.stringify(plan.targets.map((target) => target.channel)),
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify({ version: 1, items: [] }),
          JSON.stringify({ version: 1, items: [] }),
          timestamp,
          timestamp,
        );
      const insert = this.db.prepare(
        `INSERT INTO signal_publication_targets(
           publication_id,channel,provider_account_id,handle,mode,sent_text,sent_due_at
         ) VALUES(?,?,?,?,?,?,?)`,
      );
      for (const { target, input } of creates)
        insert.run(
          publicationId,
          target.channel,
          target.accountId,
          target.handle,
          target.mode,
          input.text,
          input.dueAt,
        );
    });

    let successes = 0;
    let failures = 0;
    let ambiguous = false;
    for (const { target, input } of creates) {
      try {
        const remote = await this.bufferWrite.create(input);
        successes += 1;
        this.recordBufferAnswer(publicationId, postId, plan.caption, target.accountId, remote, {
          outcome: 'SUCCESS',
          summary: `Buffer accepted ${target.handle || target.channel} as remote post ${remote.id}.`,
        });
      } catch (error) {
        const failure = error as Error;
        const uncertain = error instanceof BufferWriteError && error.ambiguous;
        ambiguous ||= uncertain;
        if (!uncertain) failures += 1;
        this.recordBufferFailure(
          publicationId,
          postId,
          plan.caption,
          target.accountId,
          failure,
          uncertain,
        );
        if (uncertain) break;
      }
    }
    const state = ambiguous
      ? successes > 0
        ? 'PARTIAL'
        : 'UNCONFIRMED'
      : failures === creates.length
        ? 'FAILED'
        : failures > 0
          ? 'PARTIAL'
          : 'SUBMITTED';
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE signal_publications SET state=?,updated_at=? WHERE id=?')
        .run(state, this.clock().toISOString(), publicationId);
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.publish',
        outcome: state === 'PARTIAL' ? 'PARTIAL' : state === 'FAILED' ? 'FAILURE' : 'SUCCESS',
        summary: ambiguous
          ? `Buffer stopped after an ambiguous answer; ${successes} target ${successes === 1 ? 'was' : 'were'} confirmed accepted.`
          : `Buffer answered ${successes + failures} target ${successes + failures === 1 ? 'submission' : 'submissions'}; ${successes} accepted and ${failures} refused.`,
        entities: [{ type: 'signalPost', id: postId, label: plan.caption.slice(0, 80) }],
        correlationId: publicationId,
      });
    });
    return this.get(publicationId) as SignalPublication;
  }

  private recordBufferAnswer(
    publicationId: string,
    postId: string,
    caption: string,
    accountId: number,
    remote: BufferWritePost,
    answer: { outcome: 'SUCCESS' | 'FAILURE'; summary: string },
  ): void {
    const timestamp = this.clock().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE signal_publication_targets
              SET outcome=?,remote_post_id=?,remote_state=?,remote_allowed_actions=?,error=?,remote_updated_at=?
            WHERE publication_id=? AND provider_account_id=?`,
        )
        .run(
          answer.outcome,
          remote.id,
          remote.state,
          JSON.stringify(remote.allowedActions),
          remote.error ? redactSecrets(remote.error) : null,
          timestamp,
          publicationId,
          accountId,
        );
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.publish',
        outcome: answer.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
        summary: answer.summary,
        entities: [{ type: 'signalPost', id: postId, label: caption.slice(0, 80) }],
        correlationId: publicationId,
        ...(remote.error ? { error: remote.error } : {}),
      });
    });
  }

  private recordBufferFailure(
    publicationId: string,
    postId: string,
    caption: string,
    accountId: number,
    error: Error,
    ambiguous: boolean,
  ): void {
    const safe = redactSecrets(error.message);
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE signal_publication_targets SET outcome=?,error=?,remote_updated_at=?
            WHERE publication_id=? AND provider_account_id=?`,
        )
        .run(
          ambiguous ? null : 'FAILURE',
          safe,
          this.clock().toISOString(),
          publicationId,
          accountId,
        );
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.publish',
        outcome: ambiguous ? 'PARTIAL' : 'FAILURE',
        summary: ambiguous
          ? 'Buffer never answered this target create; no retry was attempted and later targets were not sent.'
          : 'Buffer definitely refused this target create.',
        entities: [{ type: 'signalPost', id: postId, label: caption.slice(0, 80) }],
        correlationId: publicationId,
        error: safe,
      });
    });
  }

  /**
   * The target rows for one publication, in the order the plan resolved them.
   *
   * `rowid` rather than a channel or an account ordering: it is the insertion order, which is the
   * plan's own order, so the delivery rows read down the page the way the preview did.
   */
  private targetRows(publicationId: string): TargetRow[] {
    return targetRowsFor(this.db, publicationId);
  }

  /**
   * What the provider said about one delivery, written onto its target row.
   *
   * One statement for both callers — the submit response and the reconciliation check — because
   * they are the same fact arriving at two moments, and two copies of the write would eventually be
   * two different sets of columns.
   *
   * `post_result_id` is coalesced rather than assigned. It is the provider's own identity for this
   * delivery and the only handle its analytics endpoints accept, so a later response that omits it
   * must not erase it: an answer that says nothing about a field has said nothing about it. Every
   * other column here is what the provider just reported and is written as given.
   */
  private recordTargetResult(
    publicationId: string,
    target: NonNullable<PublishSubmission['targets']>[number],
  ): void {
    this.db
      .prepare(
        `UPDATE signal_publication_targets
            SET outcome=?,permalink=?,error=?,post_result_id=COALESCE(?, post_result_id),
                remote_post_id=COALESCE(?, remote_post_id)
          WHERE publication_id=? AND provider_account_id=?`,
      )
      .run(
        target.outcome,
        target.permalink ?? null,
        target.error ? redactSecrets(target.error) : null,
        target.resultId ?? null,
        target.remotePostId ?? null,
        publicationId,
        target.accountId,
      );
  }

  /**
   * One publication, with the drift the planner paints **Provider update required** from.
   *
   * Every read goes through here so that the flag cannot be present on one route and missing on
   * another — the planner would then show it after a refresh and not after a submit, which reads as
   * a bug in the flag rather than in the route.
   */
  private toPublicationWithDrift(row: PublicationRow, targets: TargetRow[]): SignalPublication {
    const publication = toPublication(row, targets);
    const drift = this.localDrift(row, targets);
    return drift.length ? { ...publication, driftFields: drift } : publication;
  }

  list(postId: string): SignalPublication[] {
    const rows = this.db
      .prepare('SELECT * FROM signal_publications WHERE post_id=? ORDER BY created_at DESC')
      .all(postId) as unknown as PublicationRow[];
    return rows.map((row) => this.toPublicationWithDrift(row, this.targetRows(row.id)));
  }
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM signal_publications WHERE id=?').get(id) as
      PublicationRow | undefined;
    return row ? this.toPublicationWithDrift(row, this.targetRows(row.id)) : undefined;
  }

  /**
   * Runs one provider check and records what it says about the connection.
   *
   * Wrapped here rather than at each call site because the two things worth recording are the same
   * whatever was being asked: a call that got through means the app's copy of the provider's answers
   * is current as of now, and a refusal that names a rate limit means every answer it is showing is
   * as old as that limit. Both go to `sync-health.ts`, which the queue-health summary reads; neither
   * changes the publication, and the error is rethrown untouched so every caller above still sees
   * exactly the failure it saw before.
   */
  private async checked<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      recordSyncHealth(this.db, { lastSyncedAt: this.clock().toISOString() });
      return result;
    } catch (error) {
      if (error instanceof PublishProviderError && error.rateLimited)
        recordSyncHealth(this.db, {
          rateLimitedUntil: new Date(
            this.clock().getTime() +
              (error.retryAfterSeconds ?? PUBLISH_RATE_LIMIT_FALLBACK_SECONDS) * 1000,
          ).toISOString(),
        });
      throw error;
    }
  }

  /**
   * Asks the provider what became of one submission.
   *
   * Two callers, one code path. A **manual** refresh is a person asking and always runs: it is the
   * escape hatch from any schedule, so it is never refused for being early and never spends an
   * attempt from the automatic budget. An **automatic** check is the planner's timer, and it is
   * gated on `reconcileSchedule` here as well as in the client — the client decides when to ask,
   * and the server decides whether asking was allowed, which is what keeps a loose timer from
   * turning widening intervals back into a spin.
   *
   * Both kinds record `checked_at`, because "when was this last checked" is one question however
   * it was asked.
   */
  async reconcile(
    publicationId: string,
    options: { automatic?: boolean } = {},
  ): Promise<SignalPublication> {
    const current = this.get(publicationId);
    if (!current) throw new PublishRequestError('Publication not found.', 404);
    if (current.provider === BUFFER_PROVIDER)
      return this.reconcileBuffer(current, options.automatic ?? false);
    if (!current.providerPostId)
      throw new PublishRequestError(
        'This publication has no provider id to check. Inspect it in Post Bridge.',
        409,
      );
    const automatic = options.automatic ?? false;
    // Not due, or out of budget: answered from what is already stored, with no provider call.
    if (automatic && !reconcileSchedule(current, this.clock()).due) return current;

    const providerPostId = current.providerPostId;
    this.assertProviderRoute(current.provider);
    const result = await this.checked(() => this.provider.check(providerPostId));
    const attempts = current.checkAttempts + (automatic ? 1 : 0);
    // The bound, expressed where it happens: an automatic schedule that runs out while the
    // provider still has no answer stops asking and hands the question to a person. Manual
    // refreshes never reach this, so nobody can be forced into `UNCONFIRMED` by their own clicking.
    const givingUp =
      automatic && attempts >= RECONCILE_MAX_ATTEMPTS && isReconcilableState(result.state);
    const state = givingUp ? 'UNCONFIRMED' : result.state;
    const giveUpReason = `The provider had no result after ${RECONCILE_MAX_ATTEMPTS} checks. Look at this submission in Post Bridge before resending it.`;
    const timestamp = this.clock().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE signal_publications
             SET state=?,error=?,checked_at=?,checked_state=?,prior_state=?,check_attempts=?,updated_at=?
             WHERE id=?`,
        )
        .run(
          state,
          givingUp ? giveUpReason : result.error ? redactSecrets(result.error) : null,
          timestamp,
          state,
          // What it held before this check, and only when the check moved it. A check that found
          // nothing new clears the marker rather than leaving yesterday's move to be reported
          // again as though the provider had just said it.
          state === current.state ? null : current.state,
          attempts,
          timestamp,
          publicationId,
        );
      for (const target of result.targets ?? []) this.recordTargetResult(publicationId, target);
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.reconcile',
        outcome: state === 'PARTIAL' ? 'PARTIAL' : state === 'FAILED' ? 'FAILURE' : 'SUCCESS',
        summary: givingUp
          ? `Provider check gave up after ${RECONCILE_MAX_ATTEMPTS} attempts; the result is unconfirmed.`
          : `Provider check ended ${state.toLowerCase()}.`,
        entities: [
          { type: 'signalPost', id: current.postId, label: current.sentCaption.slice(0, 80) },
        ],
        correlationId: publicationId,
        ...(result.error ? { error: result.error } : {}),
      });
    });
    return this.get(publicationId) as SignalPublication;
  }

  private async reconcileBuffer(
    current: SignalPublication,
    automatic: boolean,
  ): Promise<SignalPublication> {
    if (!this.bufferWrite.available)
      throw new PublishRequestError(
        'This Buffer publication cannot be queried through Post Bridge; Buffer publishing is not enabled for provider reads.',
        409,
      );
    if (automatic) return current;
    const answered: { target: SignalPublication['targets'][number]; remote: BufferWritePost }[] =
      [];
    try {
      for (const target of current.targets) {
        if (!target.remotePostId) continue;
        answered.push({ target, remote: await this.bufferWrite.read(target.remotePostId) });
      }
    } catch (error) {
      transaction(this.db, () => {
        recordIntegrationEvent(this.db, {
          source: 'signal-campaign',
          operation: 'signal.reconcile',
          outcome: 'FAILURE',
          summary: 'Buffer reconciliation failed before any local delivery state was changed.',
          entities: [
            {
              type: 'signalPost',
              id: current.postId,
              label: current.sentCaption.slice(0, 80),
            },
          ],
          correlationId: current.id,
          error: error instanceof Error ? error.message : 'Buffer reconciliation failed.',
        });
      });
      throw error;
    }
    if (!answered.length)
      throw new PublishRequestError(
        'No Buffer target has a known remote post id to reconcile.',
        409,
      );
    const states = answered.map(({ remote }) => remote.state);
    const state = states.every((value) => value === 'PUBLISHED')
      ? 'CONFIRMED'
      : states.every((value) => value === 'FAILED')
        ? 'FAILED'
        : states.some((value) => value === 'FAILED' || value === 'PUBLISHED')
          ? 'PARTIAL'
          : 'SUBMITTED';
    const timestamp = this.clock().toISOString();
    transaction(this.db, () => {
      const update = this.db.prepare(
        `UPDATE signal_publication_targets
            SET outcome=?,remote_state=?,remote_allowed_actions=?,remote_updated_at=?,error=?
          WHERE publication_id=? AND provider_account_id=?`,
      );
      for (const { target, remote } of answered)
        update.run(
          remote.state === 'FAILED'
            ? 'FAILURE'
            : remote.state === 'PUBLISHED'
              ? 'SUCCESS'
              : (target.outcome ?? 'SUCCESS'),
          remote.state,
          JSON.stringify(remote.allowedActions),
          timestamp,
          remote.error ? redactSecrets(remote.error) : null,
          current.id,
          target.accountId,
        );
      this.db
        .prepare(
          `UPDATE signal_publications
              SET state=?,checked_at=?,checked_state=?,prior_state=?,updated_at=? WHERE id=?`,
        )
        .run(
          state,
          timestamp,
          state,
          state === current.state ? null : current.state,
          timestamp,
          current.id,
        );
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.reconcile',
        outcome: state === 'PARTIAL' ? 'PARTIAL' : state === 'FAILED' ? 'FAILURE' : 'SUCCESS',
        summary: `Read ${answered.length} exact Buffer target ${answered.length === 1 ? 'post' : 'posts'}; the publication is ${state.toLowerCase()}.`,
        entities: [
          { type: 'signalPost', id: current.postId, label: current.sentCaption.slice(0, 80) },
        ],
        correlationId: current.id,
      });
    });
    return this.get(current.id) as SignalPublication;
  }

  async bufferTargetPreview(
    publicationId: string,
    accountId: number,
    listedTargets: readonly PublishTarget[],
  ): Promise<ProviderReconcilePreview> {
    const publication = this.get(publicationId);
    if (!publication) throw new PublishRequestError('Publication not found.', 404);
    if (publication.provider !== BUFFER_PROVIDER)
      throw new PublishRequestError('This target is not a Buffer publication.', 409);
    const target = publication.targets.find((candidate) => candidate.accountId === accountId);
    if (!target) throw new PublishRequestError('That delivery is not on this publication.', 404);
    if (!target.remotePostId)
      throw new PublishRequestError('This Buffer target has no confirmed remote post id.', 409);
    const plan = await this.preview(publication.postId, listedTargets);
    const create = this.bufferInputs(plan).find((entry) => entry.target.accountId === accountId);
    if (!create)
      throw new PublishRequestError(
        'The current Signal plan no longer resolves this Buffer target.',
        409,
      );
    const remote = await this.bufferWrite.read(target.remotePostId);
    const record: ProviderPostRecord = {
      providerPostId: remote.id,
      state: remote.state,
      caption: remote.text,
      scheduledInstant: remote.dueAt,
      mediaUrls: [],
      accountIds: [accountId],
    };
    const diffs = [
      {
        field: 'caption' as const,
        changed: create.input.text !== remote.text,
        local: create.input.text,
        remote: remote.text,
      },
      {
        field: 'schedule' as const,
        changed: create.input.dueAt !== remote.dueAt,
        local: create.input.dueAt,
        remote: remote.dueAt ?? 'Not scheduled',
      },
    ];
    const changed = diffs.filter((diff) => diff.changed).map((diff) => diff.field);
    const editAllowed = remote.allowedActions.includes('editPost');
    const deleteAllowed = remote.allowedActions.includes('deletePost');
    const actions = PROVIDER_ACTIONS.map((action) => {
      const refusals: string[] = [];
      if (action === 'UPDATE_CONTENT' && !changed.includes('caption'))
        refusals.push('Buffer already has this target content.');
      if (action === 'UPDATE_SCHEDULE' && !changed.includes('schedule'))
        refusals.push('Buffer already has this target instant.');
      if ((action === 'UPDATE_CONTENT' || action === 'UPDATE_SCHEDULE') && !editAllowed)
        refusals.push('Buffer did not return editPost in allowedActions for this post.');
      if (action === 'CANCEL' && !deleteAllowed)
        refusals.push('Buffer did not return deletePost in allowedActions for this post.');
      if (action === 'RESTORE_AND_RESUBMIT')
        refusals.push(
          'Buffer restore-and-resubmit is declined; cancel and take a fresh confirmation separately.',
        );
      return { action, available: refusals.length === 0, refusals };
    });
    return {
      publicationId,
      postId: publication.postId,
      record,
      reconcileHash: planHash({
        provider: BUFFER_PROVIDER,
        publicationId,
        accountId,
        planHash: plan.planHash,
        remote,
      }),
      diffs,
      changed,
      actions,
      warnings: [],
      refusals: [],
    };
  }

  async applyBufferTargetAction(
    publicationId: string,
    accountId: number,
    action: ProviderAction,
    expectedHash: string,
    listedTargets: readonly PublishTarget[],
  ): Promise<SignalPublication> {
    const preview = await this.bufferTargetPreview(publicationId, accountId, listedTargets);
    if (preview.reconcileHash !== expectedHash)
      throw new PublishRequestError(
        'The Signal plan or exact Buffer target changed after this comparison. Compare it again.',
        409,
      );
    const offer = providerActionOffer(preview, action);
    if (!offer?.available)
      throw new PublishRequestError(
        offer?.refusals.join(' ') || 'That action is unavailable.',
        409,
      );
    const publication = this.get(publicationId) as SignalPublication;
    const target = publication.targets.find(
      (candidate) => candidate.accountId === accountId,
    ) as SignalPublication['targets'][number];
    const plan = await this.preview(publication.postId, listedTargets);
    const create = this.bufferInputs(plan).find(
      (entry) => entry.target.accountId === accountId,
    ) as {
      input: BufferCreatePostInput;
    };
    const remoteId = target.remotePostId as string;
    if (action === 'CANCEL') {
      await this.bufferWrite.cancel(remoteId);
      const timestamp = this.clock().toISOString();
      transaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE signal_publication_targets
                SET outcome='FAILURE',remote_state=NULL,remote_allowed_actions='[]',error='Cancelled in Buffer.',remote_updated_at=?
              WHERE publication_id=? AND provider_account_id=?`,
          )
          .run(timestamp, publicationId, accountId);
        this.recomputeBufferPublicationState(publicationId, timestamp);
        recordIntegrationEvent(this.db, {
          source: 'signal-campaign',
          operation: 'signal.reconcile',
          outcome: 'SUCCESS',
          summary: `Cancelled exact Buffer target ${target.handle || target.channel}.`,
          entities: [
            {
              type: 'signalPost',
              id: publication.postId,
              label: publication.sentCaption.slice(0, 80),
            },
          ],
          correlationId: publicationId,
        });
      });
      return this.get(publicationId) as SignalPublication;
    }
    const remote = await this.bufferWrite.edit(
      action === 'UPDATE_SCHEDULE'
        ? { id: remoteId, dueAt: create.input.dueAt }
        : {
            id: remoteId,
            text: create.input.text,
            assets: create.input.assets,
            ...(create.input.metadata ? { metadata: create.input.metadata } : {}),
          },
    );
    const timestamp = this.clock().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE signal_publication_targets
              SET remote_state=?,remote_allowed_actions=?,remote_updated_at=?,error=NULL,
                  sent_text=CASE WHEN ?='UPDATE_CONTENT' THEN ? ELSE sent_text END,
                  sent_due_at=CASE WHEN ?='UPDATE_SCHEDULE' THEN ? ELSE sent_due_at END
            WHERE publication_id=? AND provider_account_id=?`,
        )
        .run(
          remote.state,
          JSON.stringify(remote.allowedActions),
          timestamp,
          action,
          create.input.text,
          action,
          create.input.dueAt,
          publicationId,
          accountId,
        );
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.reconcile',
        outcome: 'SUCCESS',
        summary: `Updated exact Buffer target ${target.handle || target.channel} ${action === 'UPDATE_SCHEDULE' ? 'schedule' : 'content'}.`,
        entities: [
          {
            type: 'signalPost',
            id: publication.postId,
            label: publication.sentCaption.slice(0, 80),
          },
        ],
        correlationId: publicationId,
      });
    });
    return this.get(publicationId) as SignalPublication;
  }

  private recomputeBufferPublicationState(publicationId: string, timestamp: string): void {
    const rows = this.db
      .prepare('SELECT outcome,error FROM signal_publication_targets WHERE publication_id=?')
      .all(publicationId) as { outcome: string | null; error: string | null }[];
    const cancelled = rows.filter((row) => row.error === 'Cancelled in Buffer.').length;
    const successful = rows.filter((row) => row.outcome === 'SUCCESS').length;
    const state =
      cancelled === rows.length
        ? 'CANCELLED'
        : cancelled > 0 && successful > 0
          ? 'PARTIAL'
          : 'SUBMITTED';
    this.db
      .prepare('UPDATE signal_publications SET state=?,updated_at=? WHERE id=?')
      .run(state, timestamp, publicationId);
  }

  /**
   * Records that a person finished one delivery where it had to be finished.
   *
   * This is the only write in the publishing service a person makes directly, and it is
   * deliberately narrow: it touches one target row and nothing else. It does not set
   * `SignalPost.status`, which stays the user's own claim through Signal's service, and it does
   * not move the publication's state, which stays what the provider said. What it records is the
   * third fact neither of those can hold — *the part only I could do is done*.
   *
   * Only a mode that needs a person can be marked. An automatic delivery has nothing for anyone to
   * finish, and saying otherwise would let a person overwrite a provider's answer by hand.
   */
  markTargetFinished(publicationId: string, accountId: number): SignalPublication {
    const publication = this.get(publicationId);
    if (!publication) throw new PublishRequestError('Publication not found.', 404);
    const target = publication.targets.find((candidate) => candidate.accountId === accountId);
    if (!target) throw new PublishRequestError('That delivery is not on this publication.', 404);
    if (!deliveryModeNeedsPerson(target.mode))
      throw new PublishRequestError(
        `${target.handle || target.channel} publishes automatically, so there is nothing for you to finish.`,
        409,
      );
    if (target.manualCompletedAt)
      throw new PublishRequestError('That delivery is already marked finished.', 409);
    const timestamp = this.clock().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE signal_publication_targets SET manual_completed_at=? WHERE publication_id=? AND provider_account_id=?',
        )
        .run(timestamp, publicationId, accountId);
      this.db
        .prepare('UPDATE signal_publications SET updated_at=? WHERE id=?')
        .run(timestamp, publicationId);
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.reconcile',
        outcome: 'SUCCESS',
        summary: `Marked the ${target.handle || target.channel} delivery finished by hand.`,
        entities: [
          {
            type: 'signalPost',
            id: publication.postId,
            label: publication.sentCaption.slice(0, 80),
          },
        ],
        correlationId: publicationId,
      });
    });
    return this.get(publicationId) as SignalPublication;
  }

  /**
   * Which of Signal's fields have moved since this publication went out.
   *
   * Local rows only, and deliberately so: this is the answer behind **Provider update required**,
   * and the criterion it serves is that a Signal edit raises the flag and mutates nothing remotely.
   * A provider call here — even a read — would make the planner touch Post Bridge every time it
   * listed a post's delivery history, which is both wasteful and the wrong shape for a claim that
   * is entirely about local disagreement.
   *
   * `accounts` cannot be answered without the provider's target list, so it is not answered here.
   * The reconciliation preview covers it, and it is the only place allowed to read.
   */
  private localDrift(row: PublicationRow, targets: TargetRow[]): ProviderDiffField[] {
    if (!publicationTracksProvider(row.state)) return [];
    const post = this.db
      .prepare('SELECT text, date, time FROM signal_posts WHERE id=?')
      .get(row.post_id) as { text: string; date: string | null; time: string } | undefined;
    if (!post) return [];
    const mediaUrls = (
      this.db
        .prepare('SELECT url FROM signal_post_media WHERE post_id=? ORDER BY position')
        .all(row.post_id) as unknown as { url: string }[]
    ).map((media) => media.url);
    let scheduledInstant: string | undefined;
    if (post.date && this.timezone) {
      try {
        scheduledInstant = publishInstantFor(post.date, post.time, this.timezone);
      } catch {
        // A wall time the zone does not have cannot be turned into an instant to compare. The
        // publishing preview already refuses that post by name, so saying nothing here is honester
        // than a second, vaguer complaint about the same clock change.
        scheduledInstant = undefined;
      }
    }
    const sameTargets = targets.map((target) => toTarget(target, row.provider));
    const drift = publicationDriftFields(
      {
        sentCaption: row.sent_caption,
        ...(row.sent_media ? { sentMedia: JSON.parse(row.sent_media) as string[] } : {}),
        scheduledInstant: row.scheduled_instant,
        targets: sameTargets,
      },
      {
        caption: post.text.trim(),
        ...(scheduledInstant ? { scheduledInstant } : {}),
        mediaUrls,
        // The publication's own targets on both sides, so `accounts` never fires from a comparison
        // this method is not in a position to make.
        targets: sameTargets.map((target) => ({
          channel: target.channel,
          platform: target.platform ?? target.channel,
          accountId: target.accountId,
          provider: target.provider,
          accountRef: target.accountRef,
          handle: target.handle,
          mode: target.mode,
        })),
      },
    );
    // A live submission whose post has been pulled back into the unscheduled queue is a real
    // disagreement — the provider is holding an instant the plan no longer claims — and the
    // comparison above cannot see it, because there is no instant left to compare against.
    if (!post.date && !drift.includes('schedule')) drift.push('schedule');
    return drift;
  }

  /**
   * The provider's record beside Signal's plan, and what may be done about the difference.
   *
   * Reads and nothing else. Two reads, in fact — the plan, which lists the provider's targets, and
   * the provider's own record of this post — and neither writes anywhere, locally or remotely. That
   * is the criterion this method is: every action has a no-write diff preview.
   */
  async providerPreview(publicationId: string): Promise<ProviderReconcilePreview> {
    const publication = this.get(publicationId);
    if (!publication) throw new PublishRequestError('Publication not found.', 404);
    const plan = await this.preview(publication.postId);
    // No provider id, or a publication the provider is no longer holding: the comparison refuses
    // itself without a call, because there is nothing out there to read.
    if (!publication.providerPostId || !publicationTracksProvider(publication.state))
      return buildProviderReconcile({ publication, plan });
    try {
      this.assertProviderRoute(publication.provider);
      return buildProviderReconcile({
        publication,
        plan,
        record: await this.provider.describe(publication.providerPostId),
      });
    } catch (error) {
      // A failed read is a preview that explains itself rather than an error page: the panel still
      // has a publication to describe, and *the provider could not be read* is the one thing the
      // user needs to know before pressing anything. Redacted on the way in like every other
      // external message this app repeats.
      return buildProviderReconcile({
        publication,
        plan,
        recordError: `The provider could not be read: ${redactSecrets((error as Error).message)}`,
      });
    }
  }

  /** The publication row plus the log entry for one withdrawal, in one transaction. */
  private recordProviderCancel(publication: SignalPublication, summary: string): void {
    const timestamp = this.clock().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE signal_publications SET state='CANCELLED',error=NULL,updated_at=? WHERE id=?",
        )
        .run(timestamp, publication.id);
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.provider-cancel',
        outcome: 'SUCCESS',
        summary,
        entities: [
          {
            type: 'signalPost',
            id: publication.postId,
            label: publication.sentCaption.slice(0, 80),
          },
        ],
        correlationId: publication.id,
      });
    });
  }

  /**
   * One full-state `PATCH`, and the local record of it.
   *
   * The snapshot columns are rewritten only on success, and that is the whole retry story: a
   * failure leaves the row saying what the provider is still holding, so the next comparison is
   * taken against the truth rather than against what this app hoped to have sent. An ambiguous
   * failure — no answer at all — moves the publication to `UNCONFIRMED` and records `PARTIAL`,
   * because *we do not know* is a different fact from *it did not happen* and only one of them is
   * safe to retry blind.
   */
  private async commitProviderUpdate(
    publication: SignalPublication,
    action: ProviderAction,
    outgoing: PublishRequest,
    configurations: string,
    mediaEvidence: {
      sources: { version: 1; items: SignalPostMedia[] };
      providerMediaIds: string[];
    },
  ): Promise<SignalPublication> {
    const providerPostId = publication.providerPostId as string;
    this.assertProviderRoute(publication.provider);
    const what = action === 'UPDATE_SCHEDULE' ? 'schedule' : 'content';
    try {
      const result = await this.provider.update(providerPostId, outgoing);
      const timestamp = this.clock().toISOString();
      transaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE signal_publications SET state=?,provider_post_id=?,scheduled_instant=?,
             sent_caption=?,sent_media=?,sent_configurations=?,sent_account_configurations=?,sent_media_sources=?,
             sent_provider_media_ids=?,error=?,updated_at=? WHERE id=?`,
          )
          .run(
            result.state,
            result.providerPostId || providerPostId,
            outgoing.scheduledInstant,
            outgoing.caption,
            JSON.stringify(mediaEvidence.sources.items.map((item) => item.url)),
            configurations,
            JSON.stringify({ version: 1, items: outgoing.accountConfigurations ?? [] }),
            JSON.stringify(mediaEvidence.sources),
            mediaEvidence.providerMediaIds.length
              ? JSON.stringify(mediaEvidence.providerMediaIds)
              : null,
            result.error ? redactSecrets(result.error) : null,
            timestamp,
            publication.id,
          );
        recordIntegrationEvent(this.db, {
          source: 'signal-campaign',
          operation: 'signal.provider-update',
          outcome: result.state === 'FAILED' ? 'FAILURE' : 'SUCCESS',
          summary: `Updated the provider ${what} from Signal.`,
          entities: [
            {
              type: 'signalPost',
              id: publication.postId,
              label: outgoing.caption.slice(0, 80),
            },
          ],
          correlationId: publication.id,
          ...(result.error ? { error: result.error } : {}),
        });
      });
    } catch (error) {
      const ambiguous = error instanceof PublishProviderError && error.ambiguous;
      const timestamp = this.clock().toISOString();
      transaction(this.db, () => {
        this.db
          .prepare('UPDATE signal_publications SET state=?,error=?,updated_at=? WHERE id=?')
          .run(
            ambiguous ? 'UNCONFIRMED' : publication.state,
            redactSecrets((error as Error).message),
            timestamp,
            publication.id,
          );
        recordIntegrationEvent(this.db, {
          source: 'signal-campaign',
          operation: 'signal.provider-update',
          outcome: ambiguous ? 'PARTIAL' : 'FAILURE',
          summary: `${
            ambiguous
              ? `The provider ${what} update was never answered; the provider may or may not have taken it.`
              : `The provider refused the ${what} update; it still holds what it had.`
          }${
            mediaEvidence.providerMediaIds.length
              ? ` ${mediaEvidence.providerMediaIds.length} fresh provider media asset${mediaEvidence.providerMediaIds.length === 1 ? '' : 's'} had already landed. Post Bridge documents unattached expiry after 24 hours; that timing remains unverified.`
              : ''
          }`,
          entities: [
            {
              type: 'signalPost',
              id: publication.postId,
              label: publication.sentCaption.slice(0, 80),
            },
          ],
          correlationId: publication.id,
          error: (error as Error).message,
        });
      });
      throw new PublishRequestError(
        ambiguous
          ? `The provider never answered the ${what} update. Check this post in Post Bridge before trying again.`
          : `The provider refused the ${what} update: ${redactSecrets((error as Error).message)}`,
        409,
        { cause: error },
      );
    }
    return this.get(publication.id) as SignalPublication;
  }

  /**
   * Commits one action against the post the provider is holding.
   *
   * The comparison is rebuilt here from scratch — the plan and the provider's record read again —
   * and the caller's token is checked against the new one. That is what makes a stale preview a
   * refusal rather than a surprise: anything that moved on either side between looking and pressing
   * invalidates the token and sends the user back to look again. The action is then checked against
   * *this* comparison's offers, so the gate the commit passes is the same computation the panel
   * showed rather than a second, looser one.
   */
  async applyProviderAction(
    publicationId: string,
    action: ProviderAction,
    expectedHash: string,
  ): Promise<SignalPublication> {
    const preview = await this.providerPreview(publicationId);
    if (preview.refusals.length) throw new PublishRequestError(preview.refusals.join(' '), 409);
    if (!preview.reconcileHash || preview.reconcileHash !== expectedHash)
      throw new PublishRequestError(
        'The post or the provider changed after this comparison was taken. Compare it again before confirming.',
        409,
      );
    const offer = providerActionOffer(preview, action);
    if (!offer?.available)
      throw new PublishRequestError(
        offer?.refusals.join(' ') || 'That action is not available on this publication.',
        409,
      );
    const publication = this.get(publicationId) as SignalPublication;
    const record = preview.record as ProviderPostRecord;
    const providerPostId = publication.providerPostId as string;
    this.assertProviderRoute(publication.provider);

    if (action === 'CANCEL') {
      await this.provider.cancel(providerPostId);
      this.recordProviderCancel(publication, 'Cancelled the provider post at your request.');
      return this.get(publicationId) as SignalPublication;
    }

    if (action === 'RESTORE_AND_RESUBMIT') {
      // Withdraw first, and only where there is something to withdraw: the provider refuses
      // `DELETE` on a post it has already failed, and asking anyway would turn a recoverable
      // situation into an error the user has to read past on the way to the fix.
      if (providerRecordNeedsWithdrawal(record)) {
        await this.provider.cancel(providerPostId);
        this.recordProviderCancel(
          publication,
          'Withdrew the provider post before resending this from Signal.',
        );
      } else {
        this.recordProviderCancel(
          publication,
          'Released the provider post locally; it had already failed, so there was nothing to withdraw.',
        );
      }
      // Two external operations and two log rows, and the first is kept whatever the second does.
      // A resubmit that fails leaves a cancelled publication and a recorded cancellation — the
      // state the user retries from, rather than a half-written one they cannot read.
      const plan = await this.preview(publication.postId);
      return this.submit(publication.postId, plan.planHash);
    }

    const plan = await this.preview(publication.postId);
    const request = plan.request as PublishRequest;
    const storedConfigurations = (
      this.db
        .prepare('SELECT sent_configurations FROM signal_publications WHERE id=?')
        .get(publicationId) as unknown as { sent_configurations: string }
    ).sent_configurations;
    const prepared = await this.prepareMedia(plan, {
      postId: publication.postId,
      correlationId: publication.id,
      operation: 'signal.provider-update',
    });

    if (action === 'UPDATE_CONTENT') {
      /**
       * Signal's content, on the instant the provider already has.
       *
       * `scheduled_at` is on the wire either way. The vendor publishes a scheduled post
       * **immediately** when an update omits it, so the field that reads as optional is the one
       * that puts a post out early, and it is never left to a default. A record holding no instant
       * at all — a draft — falls back to Signal's, because sending the provider's `null` would be
       * asking it to post right now.
       */
      const outgoing: PublishRequest = {
        ...prepared.request,
        scheduledInstant: record.scheduledInstant ?? request.scheduledInstant,
      };
      return this.commitProviderUpdate(
        publication,
        action,
        outgoing,
        JSON.stringify(request.platformConfigurations ?? []),
        prepared,
      );
    }

    /**
     * Signal's instant, on the content the provider already holds.
     *
     * The content is echoed from the provider's own record rather than taken from the current post,
     * which is the entire difference between the two update actions: rescheduling must not smuggle
     * an unreviewed caption out with it. Echoing the record rather than this app's snapshot of it is
     * the stricter of the two readings of *leave the content alone* — it is what is actually there,
     * so a full-state `PATCH` cannot overwrite anything by sending a stale copy of it. The
     * comparison has already refused this action if the two disagree, so they are the same values;
     * echoing simply removes the way for them not to be.
     */
    const outgoing: PublishRequest = {
      ...prepared.request,
      caption: record.caption,
      scheduledInstant: request.scheduledInstant,
      timezone: request.timezone,
      targets: publication.targets.map((target) => ({
        accountId: target.accountId,
        platform: target.platform ?? target.channel,
      })),
      ...(storedConfigurations && storedConfigurations !== '[]'
        ? {
            platformConfigurations: JSON.parse(
              storedConfigurations,
            ) as PublishRequest['platformConfigurations'],
          }
        : {}),
    };
    return this.commitProviderUpdate(publication, action, outgoing, storedConfigurations, prepared);
  }

  async cancelLiveForPost(postId: string): Promise<void> {
    const row = this.db
      .prepare(
        "SELECT * FROM signal_publications WHERE post_id=? AND state IN ('SUBMITTING','SUBMITTED','UNCONFIRMED') LIMIT 1",
      )
      .get(postId) as PublicationRow | undefined;
    if (!row) {
      const historical = this.db
        .prepare('SELECT 1 FROM signal_publications WHERE post_id=? LIMIT 1')
        .get(postId);
      if (historical)
        throw new PublishRequestError('Publication history protects this post from deletion.', 409);
      return;
    }
    if (!row.provider_post_id)
      throw new PublishRequestError(
        'This post has a live publication whose provider id is unknown. Resolve it before deleting the post.',
        409,
      );
    this.assertProviderRoute(row.provider);
    await this.provider.cancel(row.provider_post_id);
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE signal_publications SET state='CANCELLED',updated_at=? WHERE id=?")
        .run(this.clock().toISOString(), row.id);
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.reconcile',
        outcome: 'SUCCESS',
        summary: 'Cancelled the live provider submission when deletion was requested.',
        entities: [{ type: 'signalPost', id: row.post_id, label: row.sent_caption.slice(0, 80) }],
        correlationId: row.id,
      });
    });
    throw new PublishRequestError(
      'The provider submission was cancelled. Publication history protects this post from deletion.',
      409,
    );
  }
}

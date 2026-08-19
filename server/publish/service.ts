import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import type { SignalProvider } from '../signal/provider.ts';
import type {
  DeliveryMode,
  ProviderAction,
  ProviderDiffField,
  ProviderPostRecord,
  ProviderReconcilePreview,
  PublishPreview,
  SignalPublication,
  SignalPublicationTarget,
} from '../../shared/publish.ts';
import {
  deliveryModeNeedsPerson,
  isReconcilableState,
  providerActionOffer,
  publicationDriftFields,
  publicationTracksProvider,
  publishPreviewRefusals,
  reconcileSchedule,
  RECONCILE_MAX_ATTEMPTS,
} from '../../shared/publish.ts';
import { publishPlatformFor } from '../../shared/publish-capabilities.ts';
import type { SignalChannel } from '../../shared/signal.ts';
import { buildPublishPlan, publishInstantFor } from './plan.ts';
import { buildProviderReconcile, providerRecordNeedsWithdrawal } from './reconcile.ts';
import { PublishProviderError, type PublishProvider, type PublishRequest } from './provider.ts';

interface PublicationRow {
  id: string;
  post_id: string;
  state: SignalPublication['state'];
  provider: string;
  provider_post_id: string | null;
  scheduled_instant: string;
  timezone: string;
  sent_caption: string;
  sent_channels: string;
  /** NULL only on a row written before these columns existed. See `server/db.ts`. */
  sent_media: string | null;
  sent_configurations: string | null;
  error: string | null;
  checked_at: string | null;
  check_attempts: number;
  created_at: string;
  updated_at: string;
}

interface TargetRow {
  channel: string;
  provider_account_id: number;
  outcome: 'SUCCESS' | 'FAILURE' | null;
  permalink: string | null;
  error: string | null;
  handle: string;
  mode: string;
  manual_completed_at: string | null;
}

export class PublishRequestError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishRequestError';
    this.status = status;
  }
}

const toTarget = (row: TargetRow): SignalPublicationTarget => ({
  channel: row.channel as SignalChannel,
  platform: publishPlatformFor(row.channel) ?? null,
  accountId: row.provider_account_id,
  handle: row.handle,
  mode: row.mode as DeliveryMode,
  ...(row.outcome ? { outcome: row.outcome } : {}),
  ...(row.permalink ? { permalink: row.permalink } : {}),
  ...(row.error ? { error: row.error } : {}),
  ...(row.manual_completed_at ? { manualCompletedAt: row.manual_completed_at } : {}),
});

const toPublication = (row: PublicationRow, targets: TargetRow[]): SignalPublication => ({
  id: row.id,
  postId: row.post_id,
  state: row.state,
  provider: row.provider,
  ...(row.provider_post_id ? { providerPostId: row.provider_post_id } : {}),
  scheduledInstant: row.scheduled_instant,
  timezone: row.timezone,
  sentCaption: row.sent_caption,
  sentChannels: JSON.parse(row.sent_channels) as SignalChannel[],
  ...(row.sent_media ? { sentMedia: JSON.parse(row.sent_media) as string[] } : {}),
  ...(row.error ? { error: row.error } : {}),
  targets: targets.map(toTarget),
  ...(row.checked_at ? { checkedAt: row.checked_at } : {}),
  checkAttempts: row.check_attempts,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class PublishService {
  private readonly db: Db;
  private readonly signal: SignalProvider;
  private readonly provider: PublishProvider;
  private readonly timezone: string;
  private readonly clock: () => Date;
  constructor(
    db: Db,
    signal: SignalProvider,
    provider: PublishProvider,
    timezone: string,
    clock: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.signal = signal;
    this.provider = provider;
    this.timezone = timezone;
    this.clock = clock;
  }

  async preview(postId: string): Promise<PublishPreview & { request?: PublishRequest }> {
    if (!this.provider.available || !this.timezone)
      return {
        available: false,
        postId,
        planHash: '',
        caption: '',
        targets: [],
        channels: [],
        warnings: [],
        refusals: ['Publishing needs POST_BRIDGE_API_KEY and PUBLISH_TIMEZONE.'],
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
    // Two reads through the same read-only provider: the post, and the content overrides that
    // tailor it. Neither can write, which is what keeps the publisher unable to change a schedule
    // it is planning from.
    return buildPublishPlan(
      post,
      await this.provider.listTargets(),
      this.timezone,
      this.clock(),
      await this.signal.listVariants(postId),
    );
  }

  async submit(postId: string, expectedHash: string): Promise<SignalPublication> {
    const plan = await this.preview(postId);
    // The gate is every refusal in the plan, per-channel ones included, so a reason the preview
    // showed the user can never be stepped over at commit.
    const blockers = publishPreviewRefusals(plan);
    if (!plan.available || blockers.length || !plan.request)
      throw new PublishRequestError(blockers.join(' ') || 'Publishing is unavailable.', 400);
    const request = plan.request;
    if (plan.planHash !== expectedHash)
      throw new PublishRequestError(
        'The post or provider targets changed after preview. Preview it again before submitting.',
        409,
      );
    const publicationId = crypto.randomUUID();
    const timestamp = this.clock().toISOString();
    try {
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO signal_publications(
          id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,sent_caption,sent_channels,sent_media,sent_configurations,error,created_at,updated_at
        ) VALUES(?,?, 'SUBMITTING','post-bridge',NULL,?,?,?,?,?,?,?,NULL,?,?)`,
          )
          .run(
            publicationId,
            postId,
            crypto.randomUUID(),
            request.scheduledInstant,
            request.timezone,
            request.caption,
            JSON.stringify(plan.targets.map((target) => target.channel)),
            // The media and the tailoring go into the snapshot beside the caption, so a later
            // comparison against the provider reads the request that was sent rather than
            // re-deriving one from a post that has since been edited.
            JSON.stringify(request.mediaUrls),
            JSON.stringify(request.platformConfigurations ?? []),
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
      if ((error as Error).message.includes('UNIQUE constraint failed'))
        throw new PublishRequestError(
          'This post already has a live publication. Double-submit was blocked.',
          409,
          { cause: error },
        );
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
        for (const target of result.targets ?? [])
          this.db
            .prepare(
              'UPDATE signal_publication_targets SET outcome=?,permalink=?,error=? WHERE publication_id=? AND provider_account_id=?',
            )
            .run(
              target.outcome,
              target.permalink ?? null,
              target.error ? redactSecrets(target.error) : null,
              publicationId,
              target.accountId,
            );
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
          operation: 'signal.publish',
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
          operation: 'signal.publish',
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

  /**
   * The target rows for one publication, in the order the plan resolved them.
   *
   * `rowid` rather than a channel or an account ordering: it is the insertion order, which is the
   * plan's own order, so the delivery rows read down the page the way the preview did.
   */
  private targetRows(publicationId: string): TargetRow[] {
    return this.db
      .prepare('SELECT * FROM signal_publication_targets WHERE publication_id=? ORDER BY rowid')
      .all(publicationId) as unknown as TargetRow[];
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
    if (!current.providerPostId)
      throw new PublishRequestError(
        'This publication has no provider id to check. Inspect it in Post Bridge.',
        409,
      );
    const automatic = options.automatic ?? false;
    // Not due, or out of budget: answered from what is already stored, with no provider call.
    if (automatic && !reconcileSchedule(current, this.clock()).due) return current;

    const result = await this.provider.check(current.providerPostId);
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
          'UPDATE signal_publications SET state=?,error=?,checked_at=?,check_attempts=?,updated_at=? WHERE id=?',
        )
        .run(
          state,
          givingUp ? giveUpReason : result.error ? redactSecrets(result.error) : null,
          timestamp,
          attempts,
          timestamp,
          publicationId,
        );
      for (const target of result.targets ?? [])
        this.db
          .prepare(
            'UPDATE signal_publication_targets SET outcome=?,permalink=?,error=? WHERE publication_id=? AND provider_account_id=?',
          )
          .run(
            target.outcome,
            target.permalink ?? null,
            target.error ? redactSecrets(target.error) : null,
            publicationId,
            target.accountId,
          );
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
    const sameTargets = targets.map(toTarget);
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
  ): Promise<SignalPublication> {
    const providerPostId = publication.providerPostId as string;
    const what = action === 'UPDATE_SCHEDULE' ? 'schedule' : 'content';
    try {
      const result = await this.provider.update(providerPostId, outgoing);
      const timestamp = this.clock().toISOString();
      transaction(this.db, () => {
        this.db
          .prepare(
            `UPDATE signal_publications SET state=?,provider_post_id=?,scheduled_instant=?,
             sent_caption=?,sent_media=?,sent_configurations=?,error=?,updated_at=? WHERE id=?`,
          )
          .run(
            result.state,
            result.providerPostId || providerPostId,
            outgoing.scheduledInstant,
            outgoing.caption,
            JSON.stringify(outgoing.mediaUrls),
            configurations,
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
          summary: ambiguous
            ? `The provider ${what} update was never answered; the provider may or may not have taken it.`
            : `The provider refused the ${what} update; it still holds what it had.`,
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
        ...request,
        scheduledInstant: record.scheduledInstant ?? request.scheduledInstant,
      };
      return this.commitProviderUpdate(
        publication,
        action,
        outgoing,
        JSON.stringify(request.platformConfigurations ?? []),
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
      caption: record.caption,
      mediaUrls: record.mediaUrls,
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
    return this.commitProviderUpdate(publication, action, outgoing, storedConfigurations);
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

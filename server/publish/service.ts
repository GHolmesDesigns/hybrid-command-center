import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import type { SignalProvider } from '../signal/provider.ts';
import type { PublishPreview, SignalPublication } from '../../shared/publish.ts';
import { publishPreviewRefusals } from '../../shared/publish.ts';
import type { SignalChannel } from '../../shared/signal.ts';
import { buildPublishPlan } from './plan.ts';
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
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class PublishRequestError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishRequestError';
    this.status = status;
  }
}

const toPublication = (row: PublicationRow): SignalPublication => ({
  id: row.id,
  postId: row.post_id,
  state: row.state,
  provider: row.provider,
  ...(row.provider_post_id ? { providerPostId: row.provider_post_id } : {}),
  scheduledInstant: row.scheduled_instant,
  timezone: row.timezone,
  sentCaption: row.sent_caption,
  sentChannels: JSON.parse(row.sent_channels) as SignalChannel[],
  ...(row.error ? { error: row.error } : {}),
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
    return buildPublishPlan(post, await this.provider.listTargets(), this.timezone, this.clock());
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
          id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,sent_caption,sent_channels,error,created_at,updated_at
        ) VALUES(?,?, 'SUBMITTING','post-bridge',NULL,?,?,?,?,?,NULL,?,?)`,
          )
          .run(
            publicationId,
            postId,
            crypto.randomUUID(),
            request.scheduledInstant,
            request.timezone,
            request.caption,
            JSON.stringify(plan.targets.map((target) => target.channel)),
            timestamp,
            timestamp,
          );
        const insert = this.db.prepare(
          'INSERT INTO signal_publication_targets(publication_id,channel,provider_account_id) VALUES(?,?,?)',
        );
        for (const target of plan.targets)
          insert.run(publicationId, target.channel, target.accountId);
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

  list(postId: string): SignalPublication[] {
    const rows = this.db
      .prepare('SELECT * FROM signal_publications WHERE post_id=? ORDER BY created_at DESC')
      .all(postId) as unknown as PublicationRow[];
    return rows.map(toPublication);
  }
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM signal_publications WHERE id=?').get(id) as
      PublicationRow | undefined;
    return row ? toPublication(row) : undefined;
  }

  async reconcile(publicationId: string): Promise<SignalPublication> {
    const current = this.get(publicationId);
    if (!current) throw new PublishRequestError('Publication not found.', 404);
    if (!current.providerPostId)
      throw new PublishRequestError(
        'This publication has no provider id to check. Inspect it in Post Bridge.',
        409,
      );
    const result = await this.provider.check(current.providerPostId);
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE signal_publications SET state=?,error=?,updated_at=? WHERE id=?')
        .run(
          result.state,
          result.error ? redactSecrets(result.error) : null,
          this.clock().toISOString(),
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
        outcome:
          result.state === 'PARTIAL'
            ? 'PARTIAL'
            : result.state === 'FAILED'
              ? 'FAILURE'
              : 'SUCCESS',
        summary: `Provider check ended ${result.state.toLowerCase()}.`,
        entities: [
          { type: 'signalPost', id: current.postId, label: current.sentCaption.slice(0, 80) },
        ],
        correlationId: publicationId,
        ...(result.error ? { error: result.error } : {}),
      });
    });
    return this.get(publicationId) as SignalPublication;
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

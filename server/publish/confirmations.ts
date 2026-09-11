import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import type { PublishPreview, SignalPublication } from '../../shared/publish.ts';
import {
  PUBLISH_CONFIRMATION_PENDING_AGE_MS,
  PUBLISH_CONFIRMATION_PENDING_LIMIT,
  type PublishConfirmationStatus,
  type PublishConfirmationTiming,
} from '../../shared/publish-confirmation.ts';
import { agentLabelSchema } from '../../shared/agent-coordination.ts';
import { publishPreviewRefusals } from '../../shared/publish.ts';

export const publishConfirmationInput = z
  .object({
    agentLabel: agentLabelSchema,
    clientRequestId: z.string().trim().min(1).max(64),
    timing: z.enum(['scheduled', 'now']).default('scheduled'),
  })
  .strict();

export type PublishConfirmationInput = z.infer<typeof publishConfirmationInput>;

export type PublishConfirmationRequest = {
  id: string;
  postId: string;
  agentLabel: string;
  clientRequestId: string;
  timing: PublishConfirmationTiming;
  preview: PublishPreview;
  planHash: string;
  confirmation: string;
  status: PublishConfirmationStatus;
  createdAt: string;
  decidedAt: string | null;
  error: string | null;
};

export type PublishConfirmationQueueSummary = {
  pendingCount: number;
  oldestPendingAt: string | null;
  oldestPendingAgeMs: number | null;
  expiredCount: number;
  providerUncertainCount: number;
  limits: {
    pendingCount: number;
    pendingAgeMs: number;
  };
};

type ConfirmationRow = {
  id: string;
  post_id: string;
  agent_label: string;
  client_request_id: string;
  timing: PublishConfirmationTiming;
  preview_json: string;
  plan_hash: string;
  confirmation: string;
  status: PublishConfirmationStatus;
  created_at: string;
  executing_at: string | null;
  decided_at: string | null;
  error: string | null;
};

export class PublishConfirmationError extends Error {
  readonly status: 400 | 404 | 409;
  readonly code: 'STALE' | 'NOT_FOUND' | 'INVALID' | 'DECIDED';

  constructor(
    message: string,
    status: 400 | 404 | 409,
    code: 'STALE' | 'NOT_FOUND' | 'INVALID' | 'DECIDED',
  ) {
    super(message);
    this.name = 'PublishConfirmationError';
    this.status = status;
    this.code = code;
  }
}

const toRequest = (row: ConfirmationRow): PublishConfirmationRequest => ({
  id: row.id,
  postId: row.post_id,
  agentLabel: row.agent_label,
  clientRequestId: row.client_request_id,
  timing: row.timing,
  preview: JSON.parse(row.preview_json) as PublishPreview,
  planHash: row.plan_hash,
  confirmation: row.confirmation,
  status: row.status,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  error: row.error,
});

const previewConfirmation = (preview: PublishPreview): string => {
  const destinations = preview.targets
    .map((target) => target.handle || target.channel)
    .filter(Boolean)
    .join(', ');
  const when =
    preview.timing === 'now' ? 'now' : `at ${preview.scheduledInstant ?? 'the scheduled time'}`;
  const caption =
    preview.caption.length > 120 ? `${preview.caption.slice(0, 117)}...` : preview.caption;
  return `Publish "${caption}" ${when} to ${destinations || 'the selected channels'}.`;
};

function cleanupInTransaction(db: Db, now: Date): number {
  const before = new Date(now.getTime() - PUBLISH_CONFIRMATION_PENDING_AGE_MS).toISOString();
  const result = db
    .prepare(
      `UPDATE signal_publish_confirmation_requests
          SET status='EXPIRED', decided_at=?, error=COALESCE(error, 'Publish confirmation expired before operator action.')
        WHERE status='PENDING' AND created_at < ?`,
    )
    .run(now.toISOString(), before);
  return Number(result.changes);
}

export function cleanupPublishConfirmations(db: Db, now = new Date()): number {
  return transaction(db, () => cleanupInTransaction(db, now));
}

function assertPreviewCanBeRequested(preview: PublishPreview): void {
  const refusals = publishPreviewRefusals(preview);
  if (!preview.available || refusals.length || !preview.planHash)
    throw new PublishConfirmationError(
      refusals.join(' ') || 'Publishing is unavailable for this post.',
      400,
      'INVALID',
    );
}

export function createPublishConfirmation(
  db: Db,
  input: PublishConfirmationInput,
  preview: PublishPreview,
  now = new Date(),
): PublishConfirmationRequest {
  assertPreviewCanBeRequested(preview);
  if (preview.timing !== input.timing)
    throw new PublishConfirmationError(
      'The publish timing does not match the preview.',
      409,
      'STALE',
    );
  return transaction(db, () => {
    cleanupInTransaction(db, now);
    const prior = db
      .prepare(
        'SELECT * FROM signal_publish_confirmation_requests WHERE agent_label=? AND client_request_id=?',
      )
      .get(input.agentLabel, input.clientRequestId) as ConfirmationRow | undefined;
    if (prior) {
      if (prior.post_id !== preview.postId || prior.timing !== input.timing)
        throw new PublishConfirmationError(
          'That client request ID already belongs to another publish request.',
          409,
          'DECIDED',
        );
      return toRequest(prior);
    }
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS count FROM signal_publish_confirmation_requests WHERE status='PENDING'",
      )
      .get() as { count: number };
    if (Number(pending.count) >= PUBLISH_CONFIRMATION_PENDING_LIMIT)
      throw new PublishConfirmationError(
        'The pending publish confirmation limit has been reached.',
        409,
        'INVALID',
      );
    const request: PublishConfirmationRequest = {
      id: crypto.randomUUID(),
      postId: preview.postId,
      agentLabel: input.agentLabel,
      clientRequestId: input.clientRequestId,
      timing: input.timing,
      preview,
      planHash: preview.planHash,
      confirmation: previewConfirmation(preview),
      status: 'PENDING',
      createdAt: now.toISOString(),
      decidedAt: null,
      error: null,
    };
    db.prepare(
      `INSERT INTO signal_publish_confirmation_requests
       (id,post_id,agent_label,client_request_id,timing,preview_json,plan_hash,confirmation,status,created_at,executing_at,decided_at,error)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).run(
      request.id,
      request.postId,
      request.agentLabel,
      request.clientRequestId,
      request.timing,
      JSON.stringify(request.preview),
      request.planHash,
      request.confirmation,
      request.status,
      request.createdAt,
      null,
      null,
    );
    recordIntegrationEvent(db, {
      source: 'signal-campaign',
      operation: 'signal.publish-confirmation',
      outcome: 'SUCCESS',
      summary: `Publish confirmation requested by ${request.agentLabel}.`,
      entities: [
        { type: 'signalPost', id: request.postId, label: request.preview.caption.slice(0, 80) },
      ],
      correlationId: request.id,
    });
    return request;
  });
}

export function listPublishConfirmations(
  db: Db,
  status?: PublishConfirmationStatus,
  now = new Date(),
): PublishConfirmationRequest[] {
  cleanupPublishConfirmations(db, now);
  const rows = status
    ? db
        .prepare(
          'SELECT * FROM signal_publish_confirmation_requests WHERE status=? ORDER BY created_at DESC',
        )
        .all(status)
    : db
        .prepare('SELECT * FROM signal_publish_confirmation_requests ORDER BY created_at DESC')
        .all();
  return (rows as ConfirmationRow[]).map(toRequest);
}

export function summarizePublishConfirmations(
  db: Db,
  now = new Date(),
): PublishConfirmationQueueSummary {
  cleanupPublishConfirmations(db, now);
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
         FROM signal_publish_confirmation_requests WHERE status='PENDING'`,
    )
    .get() as { count: number; oldest: string | null };
  const terminal = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN status='PROVIDER_UNCERTAIN' THEN 1 ELSE 0 END) AS uncertain
       FROM signal_publish_confirmation_requests`,
    )
    .get() as { expired: number | null; uncertain: number | null };
  return {
    pendingCount: Number(pending.count),
    oldestPendingAt: pending.oldest,
    oldestPendingAgeMs: pending.oldest
      ? Math.max(0, now.getTime() - new Date(pending.oldest).getTime())
      : null,
    expiredCount: Number(terminal.expired ?? 0),
    providerUncertainCount: Number(terminal.uncertain ?? 0),
    limits: {
      pendingCount: PUBLISH_CONFIRMATION_PENDING_LIMIT,
      pendingAgeMs: PUBLISH_CONFIRMATION_PENDING_AGE_MS,
    },
  };
}

export function getPublishConfirmation(db: Db, id: string, now = new Date()) {
  cleanupPublishConfirmations(db, now);
  const row = db
    .prepare('SELECT * FROM signal_publish_confirmation_requests WHERE id=?')
    .get(id) as ConfirmationRow | undefined;
  if (!row) throw new PublishConfirmationError('Publish confirmation not found.', 404, 'NOT_FOUND');
  return toRequest(row);
}

function updateDecision(
  db: Db,
  request: PublishConfirmationRequest,
  status: PublishConfirmationStatus,
  now: Date,
  error?: string,
): PublishConfirmationRequest {
  return transaction(db, () => {
    db.prepare(
      'UPDATE signal_publish_confirmation_requests SET status=?, decided_at=?, error=? WHERE id=?',
    ).run(status, now.toISOString(), error ?? null, request.id);
    const outcome =
      status === 'FAILED' || status === 'DENIED' || status === 'EXPIRED'
        ? 'FAILURE'
        : status === 'PROVIDER_UNCERTAIN'
          ? 'PARTIAL'
          : 'SUCCESS';
    recordIntegrationEvent(db, {
      source: 'signal-campaign',
      operation: 'signal.publish-confirmation',
      outcome,
      summary:
        status === 'APPROVED'
          ? `Publish confirmation approved for ${request.agentLabel}.`
          : status === 'DENIED'
            ? `Publish confirmation denied for ${request.agentLabel}.`
            : `Publish confirmation ended ${status.toLowerCase()}.`,
      entities: [
        { type: 'signalPost', id: request.postId, label: request.preview.caption.slice(0, 80) },
      ],
      correlationId: request.id,
      ...(error ? { error } : {}),
    });
    return toRequest(
      db
        .prepare('SELECT * FROM signal_publish_confirmation_requests WHERE id=?')
        .get(request.id) as ConfirmationRow,
    );
  });
}

export async function decidePublishConfirmation(
  db: Db,
  id: string,
  decision: 'approve' | 'deny',
  execute: (request: PublishConfirmationRequest) => Promise<SignalPublication>,
  now = new Date(),
): Promise<PublishConfirmationRequest> {
  const request = getPublishConfirmation(db, id, now);
  if (request.status !== 'PENDING')
    throw new PublishConfirmationError('Publish confirmation was already decided.', 409, 'DECIDED');
  if (decision === 'deny') return updateDecision(db, request, 'DENIED', now, 'Denied by operator.');

  const claimed = transaction(db, () =>
    db
      .prepare(
        "UPDATE signal_publish_confirmation_requests SET status='EXECUTING', executing_at=? WHERE id=? AND status='PENDING'",
      )
      .run(now.toISOString(), id),
  );
  if (Number(claimed.changes) !== 1)
    throw new PublishConfirmationError('Publish confirmation was already decided.', 409, 'DECIDED');
  try {
    const publication = await execute(request);
    const status: PublishConfirmationStatus =
      publication.state === 'FAILED'
        ? 'FAILED'
        : publication.state === 'UNCONFIRMED'
          ? 'PROVIDER_UNCERTAIN'
          : 'APPROVED';
    return updateDecision(db, request, status, now, publication.error);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message.slice(0, 500) : 'Publish confirmation failed.',
    );
    const status: PublishConfirmationStatus =
      error instanceof PublishConfirmationError && error.code === 'STALE' ? 'EXPIRED' : 'FAILED';
    updateDecision(db, request, status, now, message);
    throw error;
  }
}

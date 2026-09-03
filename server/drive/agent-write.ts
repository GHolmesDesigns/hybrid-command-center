import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import {
  commitDriveWrite,
  previewDriveFolderCreate,
  previewDriveUpload,
  type DriveWritePlan,
  type DriveWriteProvider,
} from './write.ts';

export const DRIVE_WRITE_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
export const DRIVE_WRITE_EXECUTION_LEASE_MS = 60 * 60 * 1000;
export const DRIVE_WRITE_PENDING_LIMIT = 20;
export const DRIVE_WRITE_PENDING_BYTES_LIMIT = 50 * 1024 * 1024;

export const driveWriteRequestInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create-folder'),
    projectId: z.string().uuid(),
    parentId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    clientRequestId: z.string().trim().min(1).max(64),
  }),
  z.object({
    kind: z.literal('upload-file'),
    projectId: z.string().uuid(),
    folderId: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    mimeType: z.string().trim().min(1).max(200),
    contentBase64: z.string().min(1),
    clientRequestId: z.string().trim().min(1).max(64),
  }),
]);

export type DriveWriteRequest = {
  id: string;
  agentLabel: string;
  plan: RequestPlan;
  planHash: string;
  confirmation: string;
  status:
    'PENDING' | 'EXECUTING' | 'APPROVED' | 'DENIED' | 'FAILED' | 'EXPIRED' | 'PROVIDER_UNCERTAIN';
  createdAt: string;
  decidedAt: string | null;
  error: string | null;
};

type RequestPlan =
  | DriveWritePlan
  | (Omit<Extract<DriveWritePlan, { kind: 'upload-file' }>, 'contentBase64'> & {
      kind: 'upload-file';
    });

type RequestRow = {
  id: string;
  agent_label: string;
  plan_json: string;
  plan_hash: string;
  confirmation: string;
  status: DriveWriteRequest['status'];
  created_at: string;
  executing_at: string | null;
  decided_at: string | null;
  error: string | null;
};

export type DriveWriteQueueSummary = {
  pendingCount: number;
  pendingDecodedBytes: number;
  oldestPendingAt: string | null;
  oldestPendingAgeMs: number | null;
  expiredCount: number;
  providerUncertainCount: number;
  limits: {
    pendingCount: number;
    pendingDecodedBytes: number;
    pendingAgeMs: number;
    executionLeaseMs: number;
  };
};

const publicPlan = (plan: DriveWritePlan): RequestPlan => {
  if (plan.kind !== 'upload-file') return plan;
  return Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== 'contentBase64'),
  ) as RequestPlan;
};

const toRequest = (row: RequestRow): DriveWriteRequest => ({
  id: row.id,
  agentLabel: row.agent_label,
  plan: publicPlan(JSON.parse(row.plan_json) as DriveWritePlan),
  planHash: row.plan_hash,
  confirmation: row.confirmation,
  status: row.status,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  error: row.error,
});

const purgePlanPayload = (planJson: string) => {
  const plan = JSON.parse(planJson) as Record<string, unknown>;
  if (plan.kind === 'upload-file') delete plan.contentBase64;
  return JSON.stringify(plan);
};

/**
 * Expires abandoned work and removes upload bytes from every terminal request.
 * Both operations are deliberately one transaction so a restart cannot expose a
 * half-cleaned queue or count a request twice.
 */
function cleanupDriveWriteRequestsInTransaction(db: Db, now: Date): number {
  const pendingBefore = new Date(now.getTime() - DRIVE_WRITE_PENDING_AGE_MS).toISOString();
  const executingBefore = new Date(now.getTime() - DRIVE_WRITE_EXECUTION_LEASE_MS).toISOString();
  const expired = db
    .prepare(
      `UPDATE drive_write_requests
            SET status='EXPIRED', decided_at=?, error=COALESCE(error, 'Pending Drive write request expired.')
          WHERE status='PENDING' AND created_at < ?`,
    )
    .run(now.toISOString(), pendingBefore);
  db.prepare(
    `UPDATE drive_write_requests
          SET status='PROVIDER_UNCERTAIN', decided_at=?,
              error=COALESCE(error, 'Execution lease expired; provider outcome is uncertain.')
        WHERE status='EXECUTING' AND COALESCE(executing_at, created_at) < ?`,
  ).run(now.toISOString(), executingBefore);
  const terminal = db
    .prepare(
      `SELECT id, plan_json FROM drive_write_requests
           WHERE status IN ('APPROVED','DENIED','FAILED','EXPIRED','PROVIDER_UNCERTAIN')`,
    )
    .all() as { id: string; plan_json: string }[];
  const update = db.prepare('UPDATE drive_write_requests SET plan_json=? WHERE id=?');
  for (const row of terminal) {
    const purged = purgePlanPayload(row.plan_json);
    if (purged !== row.plan_json) update.run(purged, row.id);
  }
  return Number(expired.changes);
}

export function cleanupDriveWriteRequests(db: Db, now = new Date()): number {
  return transaction(db, () => cleanupDriveWriteRequestsInTransaction(db, now));
}

const pendingUploadBytes = (db: Db): number => {
  const rows = db
    .prepare("SELECT plan_json FROM drive_write_requests WHERE status='PENDING'")
    .all() as { plan_json: string }[];
  return rows.reduce((total, row) => {
    const plan = JSON.parse(row.plan_json) as Partial<
      Extract<DriveWritePlan, { kind: 'upload-file' }>
    >;
    return total + (plan.kind === 'upload-file' ? (plan.size ?? 0) : 0);
  }, 0);
};

export function summarizeDriveWriteRequests(db: Db, now = new Date()): DriveWriteQueueSummary {
  cleanupDriveWriteRequests(db, now);
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN json_extract(plan_json, '$.kind')='upload-file'
                                THEN json_extract(plan_json, '$.size') ELSE 0 END), 0) AS bytes,
              MIN(created_at) AS oldest
         FROM drive_write_requests
        WHERE status='PENDING'`,
    )
    .get() as { count: number; bytes: number; oldest: string | null };
  const terminal = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN status='PROVIDER_UNCERTAIN' THEN 1 ELSE 0 END) AS uncertain
       FROM drive_write_requests`,
    )
    .get() as { expired: number | null; uncertain: number | null };
  const oldestPendingAgeMs = pending.oldest
    ? Math.max(0, now.getTime() - new Date(pending.oldest).getTime())
    : null;
  return {
    pendingCount: Number(pending.count),
    pendingDecodedBytes: Number(pending.bytes),
    oldestPendingAt: pending.oldest,
    oldestPendingAgeMs,
    expiredCount: Number(terminal.expired ?? 0),
    providerUncertainCount: Number(terminal.uncertain ?? 0),
    limits: {
      pendingCount: DRIVE_WRITE_PENDING_LIMIT,
      pendingDecodedBytes: DRIVE_WRITE_PENDING_BYTES_LIMIT,
      pendingAgeMs: DRIVE_WRITE_PENDING_AGE_MS,
      executionLeaseMs: DRIVE_WRITE_EXECUTION_LEASE_MS,
    },
  };
}

function auditRequest(
  db: Db,
  request: DriveWriteRequest,
  outcome: 'SUCCESS' | 'FAILURE',
  error?: string,
) {
  recordIntegrationEvent(db, {
    source: 'google-drive',
    operation: 'drive.agent-write-request',
    outcome,
    summary:
      outcome === 'SUCCESS'
        ? `Agent Drive write request ${request.status.toLowerCase()}: ${request.confirmation}`
        : `Agent Drive write request failed: ${request.confirmation}`,
    correlationId: request.id,
    error,
  });
}

export function requestDriveWrite(
  db: Db,
  agentLabel: string,
  input: unknown,
  now = new Date(),
): DriveWriteRequest {
  const args = driveWriteRequestInput.parse(input);
  let created = false;
  const request = transaction(db, () => {
    cleanupDriveWriteRequestsInTransaction(db, now);
    const prior = db
      .prepare('SELECT * FROM drive_write_requests WHERE agent_label=? AND client_request_id=?')
      .get(agentLabel, args.clientRequestId) as RequestRow | undefined;
    if (prior) return toRequest(prior);
    const preview =
      args.kind === 'create-folder'
        ? previewDriveFolderCreate(db, args)
        : previewDriveUpload(db, args);
    const pending = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM drive_write_requests WHERE status='PENDING'")
          .get() as {
          count: number;
        }
      ).count,
    );
    if (pending >= DRIVE_WRITE_PENDING_LIMIT)
      throw new Error('The pending Drive write request limit has been reached.');
    const bytes =
      pendingUploadBytes(db) + (preview.plan.kind === 'upload-file' ? preview.plan.size : 0);
    if (bytes > DRIVE_WRITE_PENDING_BYTES_LIMIT)
      throw new Error('The pending Drive upload byte limit has been reached.');
    const request: DriveWriteRequest = {
      id: crypto.randomUUID(),
      agentLabel,
      plan: preview.plan,
      planHash: preview.planHash,
      confirmation: preview.confirmation,
      status: 'PENDING',
      createdAt: now.toISOString(),
      decidedAt: null,
      error: null,
    };
    created = true;
    db.prepare(
      `INSERT INTO drive_write_requests
      (id, agent_label, client_request_id, plan_json, plan_hash, confirmation, status, created_at, executing_at, decided_at, error)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).run(
      request.id,
      agentLabel,
      args.clientRequestId,
      JSON.stringify(request.plan),
      request.planHash,
      request.confirmation,
      request.status,
      request.createdAt,
      null,
      null,
    );
    return request;
  });
  if (created) auditRequest(db, request, 'SUCCESS');
  return request;
}

export function listDriveWriteRequests(
  db: Db,
  status?: DriveWriteRequest['status'],
  now = new Date(),
): DriveWriteRequest[] {
  cleanupDriveWriteRequests(db, now);
  const rows = status
    ? db
        .prepare('SELECT * FROM drive_write_requests WHERE status=? ORDER BY created_at DESC')
        .all(status)
    : db.prepare('SELECT * FROM drive_write_requests ORDER BY created_at DESC').all();
  return (rows as RequestRow[]).map(toRequest);
}

export async function decideDriveWrite(
  db: Db,
  id: string,
  decision: 'approve' | 'deny',
  provider: DriveWriteProvider,
  now = new Date(),
): Promise<DriveWriteRequest> {
  cleanupDriveWriteRequests(db, now);
  const row = db.prepare('SELECT * FROM drive_write_requests WHERE id=?').get(id) as
    RequestRow | undefined;
  if (!row) throw new Error('Drive write request not found.');
  const request = toRequest(row);
  if (request.status !== 'PENDING') throw new Error('Drive write request was already decided.');
  if (decision === 'deny') {
    transaction(db, () => {
      db.prepare(
        "UPDATE drive_write_requests SET status='DENIED', decided_at=? WHERE id=? AND status='PENDING'",
      ).run(now.toISOString(), id);
      db.prepare('UPDATE drive_write_requests SET plan_json=? WHERE id=?').run(
        purgePlanPayload(row.plan_json),
        id,
      );
    });
    const decided = toRequest(
      db.prepare('SELECT * FROM drive_write_requests WHERE id=?').get(id) as RequestRow,
    );
    auditRequest(db, decided, 'FAILURE', 'Denied by operator.');
    return decided;
  }
  const claimed = transaction(db, () =>
    db
      .prepare(
        "UPDATE drive_write_requests SET status='EXECUTING', executing_at=? WHERE id=? AND status='PENDING'",
      )
      .run(now.toISOString(), id),
  );
  if (Number(claimed.changes) !== 1) throw new Error('Drive write request was already decided.');
  try {
    await commitDriveWrite(
      db,
      JSON.parse(row.plan_json) as DriveWritePlan,
      request.planHash,
      provider,
    );
    transaction(db, () => {
      const completed = db
        .prepare(
          "UPDATE drive_write_requests SET status='APPROVED', decided_at=? WHERE id=? AND status='EXECUTING'",
        )
        .run(now.toISOString(), id);
      if (Number(completed.changes) !== 1)
        throw new Error('Drive write execution lease expired; provider outcome is uncertain.');
      db.prepare('UPDATE drive_write_requests SET plan_json=? WHERE id=?').run(
        purgePlanPayload(row.plan_json),
        id,
      );
    });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message.slice(0, 500) : 'Drive write failed.',
    );
    const uncertain = isUncertainProviderError(error);
    const status: DriveWriteRequest['status'] = uncertain ? 'PROVIDER_UNCERTAIN' : 'FAILED';
    transaction(db, () => {
      db.prepare(
        `UPDATE drive_write_requests SET status=?, decided_at=?, error=? WHERE id=? AND status='EXECUTING'`,
      ).run(status, now.toISOString(), message, id);
      db.prepare('UPDATE drive_write_requests SET plan_json=? WHERE id=?').run(
        purgePlanPayload(row.plan_json),
        id,
      );
    });
    const failed = { ...request, status, error: message };
    auditRequest(db, failed, 'FAILURE', message);
    throw error;
  }
  const approved = toRequest(
    db.prepare('SELECT * FROM drive_write_requests WHERE id=?').get(id) as RequestRow,
  );
  auditRequest(db, approved, 'SUCCESS');
  return approved;
}

function isUncertainProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const candidate = error as Error & { code?: string | number };
  if (
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(
      String(candidate.code),
    )
  )
    return true;
  return /\b(timeout|timed out|network|socket|connection reset|fetch failed|temporarily unavailable)\b/i.test(
    error.message,
  );
}

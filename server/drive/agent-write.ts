import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { recordIntegrationEvent } from '../integration-log.ts';
import {
  commitDriveWrite,
  previewDriveFolderCreate,
  previewDriveUpload,
  type DriveWritePlan,
  type DriveWriteProvider,
} from './write.ts';

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
  plan: DriveWritePlan;
  planHash: string;
  confirmation: string;
  status: 'PENDING' | 'EXECUTING' | 'APPROVED' | 'DENIED' | 'FAILED';
  createdAt: string;
  decidedAt: string | null;
  error: string | null;
};

type RequestRow = {
  id: string;
  agent_label: string;
  plan_json: string;
  plan_hash: string;
  confirmation: string;
  status: DriveWriteRequest['status'];
  created_at: string;
  decided_at: string | null;
  error: string | null;
};

const toRequest = (row: RequestRow): DriveWriteRequest => ({
  id: row.id,
  agentLabel: row.agent_label,
  plan: JSON.parse(row.plan_json) as DriveWritePlan,
  planHash: row.plan_hash,
  confirmation: row.confirmation,
  status: row.status,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  error: row.error,
});

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
  const prior = db
    .prepare('SELECT * FROM drive_write_requests WHERE agent_label=? AND client_request_id=?')
    .get(agentLabel, args.clientRequestId) as RequestRow | undefined;
  if (prior) return toRequest(prior);
  const preview =
    args.kind === 'create-folder'
      ? previewDriveFolderCreate(db, args)
      : previewDriveUpload(db, args);
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
  transaction(db, () => {
    db.prepare(
      `INSERT INTO drive_write_requests
      (id, agent_label, client_request_id, plan_json, plan_hash, confirmation, status, created_at, decided_at, error)
      VALUES(?,?,?,?,?,?,?,?,?,NULL)`,
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
    );
  });
  auditRequest(db, request, 'SUCCESS');
  return request;
}

export function listDriveWriteRequests(
  db: Db,
  status?: DriveWriteRequest['status'],
): DriveWriteRequest[] {
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
  const row = db.prepare('SELECT * FROM drive_write_requests WHERE id=?').get(id) as
    RequestRow | undefined;
  if (!row) throw new Error('Drive write request not found.');
  const request = toRequest(row);
  if (request.status !== 'PENDING') throw new Error('Drive write request was already decided.');
  if (decision === 'deny') {
    db.prepare(
      "UPDATE drive_write_requests SET status='DENIED', decided_at=? WHERE id=? AND status='PENDING'",
    ).run(now.toISOString(), id);
    const decided = toRequest(
      db.prepare('SELECT * FROM drive_write_requests WHERE id=?').get(id) as RequestRow,
    );
    auditRequest(db, decided, 'FAILURE', 'Denied by operator.');
    return decided;
  }
  const claimed = db
    .prepare("UPDATE drive_write_requests SET status='EXECUTING' WHERE id=? AND status='PENDING'")
    .run(id);
  if (Number(claimed.changes) !== 1) throw new Error('Drive write request was already decided.');
  try {
    await commitDriveWrite(db, request.plan, request.planHash, provider);
    db.prepare("UPDATE drive_write_requests SET status='APPROVED', decided_at=? WHERE id=?").run(
      now.toISOString(),
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Drive write failed.';
    db.prepare(
      "UPDATE drive_write_requests SET status='FAILED', decided_at=?, error=? WHERE id=?",
    ).run(now.toISOString(), message, id);
    const failed = { ...request, status: 'FAILED' as const, error: message };
    auditRequest(db, failed, 'FAILURE', message);
    throw error;
  }
  const approved = toRequest(
    db.prepare('SELECT * FROM drive_write_requests WHERE id=?').get(id) as RequestRow,
  );
  auditRequest(db, approved, 'SUCCESS');
  return approved;
}

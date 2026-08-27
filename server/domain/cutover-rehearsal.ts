/**
 * Cloud cutover rehearsal and production cutover rules (C55 / #181; C115 / #363).
 *
 * Framework-free on purpose: post-restore verification and operator abort conditions live here
 * so the CLI, tests, and runbook cannot diverge. Nothing here touches a database or a network —
 * callers pass snapshot summaries and get a decision. Staging vs production steps live in
 * docs/cloud-cutover-rehearsal.md; agents never execute the production column.
 */

export interface CutoverSnapshot {
  clients: number;
  projects: number;
  tasks: number;
  integrityOk: boolean;
  foreignKeysOk: boolean;
  hasEncryptedDriveTokens: boolean;
  driveReferenceCount: number;
}

export interface CutoverVerification {
  countsMatch: boolean;
  driveTokensPreserved: boolean;
  integrityOk: boolean;
  foreignKeysOk: boolean;
}

export interface CutoverFailureDecision {
  situation: string;
  action: string;
  abort: boolean;
}

/** Actions that require a human operator — agents and CI must never perform these. */
export const CUTOVER_OPERATOR_STOPS = [
  'Move production data or restore a live workspace snapshot',
  'Create or change provider or OAuth credentials',
  'Revoke a Google grant or register a production redirect URI',
  'Rotate or enter an encryption or session key on the host',
  'Change DNS or the production public origin',
  'Freeze the live workspace or declare the host authoritative',
] as const;

/** Production-column checklist headings from docs/cloud-cutover-rehearsal.md (C115). */
export const CUTOVER_PRODUCTION_CHECKLIST = [
  'Freeze or snapshot source',
  'Transfer snapshot and key separately',
  'Deploy on empty volume with SSM secrets (no UNSET)',
  'Set APP_ORIGIN / GOOGLE_REDIRECT_URI, Wix DNS, and Caddy TLS',
  'Restore and migrate on the production volume',
  'Enable backup timers and monitoring',
  'Authenticated HTTPS smoke including second-device login',
  'Drive reconnect under drive.file + Picker',
  'Declare host authoritative and name the public origin in docs',
] as const;

export const CUTOVER_FAILURE_DECISIONS: CutoverFailureDecision[] = [
  {
    situation: 'Backup or restore fails integrity or foreign-key checks',
    action: 'Do not cut over. Fix or replace the snapshot; keep the current authoritative copy.',
    abort: true,
  },
  {
    situation: 'Host is up but Drive tokens will not decrypt',
    action:
      'Restore GOOGLE_TOKEN_ENCRYPTION_KEY from the separate backup. If the key is lost, reconnect Drive in Settings (folder IDs survive).',
    abort: true,
  },
  {
    situation: 'Restore rehearsal marker shows FAILURE or off-site rehearsal failed',
    action:
      'Do not cut over. Inspect REHEARSAL-FAILED.txt or the off-site rehearsal marker, fix the backup path, and rerun rehearsal on a disposable copy.',
    abort: true,
  },
  {
    situation: 'Authentication, CSRF, proxy trust, or bind-gate preflight fails on staging',
    action:
      'Fix SESSION_SECRET, OPERATOR_PASSWORD_HASH, APP_ORIGIN, PRODUCTION_TLS_TERMINATED, and TRUSTED_PROXY_HOPS before any traffic. Do not widen HOST.',
    abort: true,
  },
  {
    situation: 'Hosted writes exist and operator needs rollback',
    action:
      'Freeze writes, take and verify a fresh hosted backup, restore that snapshot — not the pre-cutover laptop copy.',
    abort: true,
  },
  {
    situation: 'Workspace counts or Drive references differ after restore rehearsal',
    action: 'Do not cut over. Re-run db:backup:rehearse on a copy and compare the report.',
    abort: true,
  },
  {
    situation: 'Backup age exceeds RPO or disk alarm is critical',
    action:
      'Resolve monitoring before cutover: run off-site backup, confirm rehearsal passed, free disk space.',
    abort: true,
  },
  {
    situation: 'Operator wants to leave the cloud',
    action:
      'db:backup on the host, restore locally, return HOST to loopback, remove production redirect when ready.',
    abort: false,
  },
];

export function verifyPostRestore(
  before: CutoverSnapshot,
  after: CutoverSnapshot,
): CutoverVerification {
  return {
    countsMatch:
      before.clients === after.clients &&
      before.projects === after.projects &&
      before.tasks === after.tasks,
    driveTokensPreserved: before.hasEncryptedDriveTokens === after.hasEncryptedDriveTokens,
    integrityOk: after.integrityOk,
    foreignKeysOk: after.foreignKeysOk,
  };
}

export function cutoverVerificationPassed(verification: CutoverVerification): boolean {
  return (
    verification.countsMatch &&
    verification.driveTokensPreserved &&
    verification.integrityOk &&
    verification.foreignKeysOk
  );
}

export function formatCutoverVerificationReport(input: {
  label: string;
  before: CutoverSnapshot;
  after: CutoverSnapshot;
  verification: CutoverVerification;
}): string {
  const { label, before, after, verification } = input;
  const lines = [
    label,
    '',
    `Counts:     clients ${before.clients}→${after.clients}, projects ${before.projects}→${after.projects}, tasks ${before.tasks}→${after.tasks}`,
    `Drive refs: ${before.driveReferenceCount}→${after.driveReferenceCount}`,
    `Encrypted Drive tokens: ${before.hasEncryptedDriveTokens ? 'yes' : 'no'}→${after.hasEncryptedDriveTokens ? 'yes' : 'no'}`,
    `Integrity:  ${after.integrityOk ? 'ok' : 'FAILED'}`,
    `Foreign keys: ${after.foreignKeysOk ? 'ok' : 'FAILED'}`,
    '',
    cutoverVerificationPassed(verification)
      ? 'Post-restore verification passed.'
      : 'Post-restore verification FAILED.',
  ];
  return lines.join('\n');
}

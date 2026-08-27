import { describe, expect, it } from 'vitest';
import {
  cutoverVerificationPassed,
  CUTOVER_FAILURE_DECISIONS,
  CUTOVER_OPERATOR_STOPS,
  CUTOVER_PRODUCTION_CHECKLIST,
  formatCutoverVerificationReport,
  verifyPostRestore,
  type CutoverSnapshot,
} from './cutover-rehearsal.ts';

const snapshot = (overrides: Partial<CutoverSnapshot> = {}): CutoverSnapshot => ({
  clients: 2,
  projects: 3,
  tasks: 5,
  integrityOk: true,
  foreignKeysOk: true,
  hasEncryptedDriveTokens: true,
  driveReferenceCount: 4,
  ...overrides,
});

describe('verifyPostRestore', () => {
  it('passes when counts, tokens, and integrity match', () => {
    const before = snapshot();
    const after = snapshot();
    const verification = verifyPostRestore(before, after);
    expect(cutoverVerificationPassed(verification)).toBe(true);
  });

  it('fails when a row count changed after restore', () => {
    const verification = verifyPostRestore(snapshot(), snapshot({ clients: 3 }));
    expect(verification.countsMatch).toBe(false);
    expect(cutoverVerificationPassed(verification)).toBe(false);
  });

  it('fails when encrypted token presence changed', () => {
    const verification = verifyPostRestore(
      snapshot({ hasEncryptedDriveTokens: true }),
      snapshot({ hasEncryptedDriveTokens: false }),
    );
    expect(verification.driveTokensPreserved).toBe(false);
  });
});

describe('formatCutoverVerificationReport', () => {
  it('names a failure in the report text', () => {
    const before = snapshot();
    const after = snapshot({ tasks: 99 });
    const verification = verifyPostRestore(before, after);
    const report = formatCutoverVerificationReport({
      label: 'Rollback rehearsal',
      before,
      after,
      verification,
    });
    expect(report).toContain('Post-restore verification FAILED.');
    expect(report).toContain('tasks 5→99');
  });
});

describe('operator guardrails', () => {
  it('lists human-only stop conditions', () => {
    expect(CUTOVER_OPERATOR_STOPS.length).toBeGreaterThan(0);
    expect(CUTOVER_OPERATOR_STOPS.some((line) => line.includes('DNS'))).toBe(true);
  });

  it('covers rollback with a fresh hosted snapshot', () => {
    const rollback = CUTOVER_FAILURE_DECISIONS.find((row) =>
      row.situation.includes('Hosted writes exist'),
    );
    expect(rollback?.action).toContain('fresh hosted backup');
    expect(rollback?.abort).toBe(true);
  });

  it('pins the production cutover checklist (C115)', () => {
    expect(CUTOVER_PRODUCTION_CHECKLIST).toHaveLength(9);
    expect(CUTOVER_PRODUCTION_CHECKLIST.some((step) => step.includes('second-device'))).toBe(true);
    expect(CUTOVER_PRODUCTION_CHECKLIST.some((step) => step.includes('public origin'))).toBe(true);
  });
});

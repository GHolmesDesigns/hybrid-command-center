/**
 * Deterministic MCP agent evaluation suite (C134 / #384).
 *
 * Runs against fixture databases only — never production. Production smoke is
 * `npm run eval:mcp-smoke` (owner-run, plan by default).
 */
import { describe, expect, it } from 'vitest';
import {
  runAllFixtureScenarios,
  runAvoidClaimed,
  runDiscoverTask,
  runImpersonationRefused,
  runLostResponseRecovery,
  runRateLimitPersistence,
  runReadOnlyChecksumSmoke,
  runValidationEvidence,
} from './eval/scenarios.ts';
import { openEvalContext } from './eval/harness.ts';
import { renderFixtureMatrix, summarizeEvalRun } from './eval/score.ts';
import { createDb } from '../db.ts';

describe('MCP agent evaluation suite (C134)', () => {
  it('passes every fixture scenario with complete evidence', async () => {
    const results = await runAllFixtureScenarios();
    const summary = summarizeEvalRun(results, '2026-08-29T16:00:00.000Z');
    const matrix = renderFixtureMatrix(summary);
    expect(matrix).toContain('Fixture evaluation matrix');
    expect(summary.totals.succeeded).toBe(summary.totals.scenarios);
    expect(summary.totals.evidenceComplete).toBe(summary.totals.scenarios);
    for (const result of results) {
      expect(result, result.id).toMatchObject({ success: true, evidenceComplete: true });
    }
  }, 120_000);

  it('covers every §2 defect with a dedicated failing-on-pre-fix case', async () => {
    const results = await runAllFixtureScenarios();
    const byDefect = new Map(
      results.filter((result) => result.defect).map((result) => [result.defect, result]),
    );
    for (const defect of ['D1', 'D2', 'D3', 'D4', 'D5'] as const) {
      expect(byDefect.get(defect)?.success, defect).toBe(true);
    }
  }, 120_000);

  it('keeps discovery and connection diagnostics checksum-clean', async () => {
    const db = createDb(':memory:');
    try {
      const result = await runReadOnlyChecksumSmoke(openEvalContext(db));
      expect(result.success).toBe(true);
      expect(result.evidenceComplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it('refuses claimed work, incomplete completion, lost-response duplicates, and impersonation', async () => {
    const dbA = createDb(':memory:');
    try {
      expect((await runAvoidClaimed(openEvalContext(dbA))).success).toBe(true);
    } finally {
      dbA.close();
    }
    const dbB = createDb(':memory:');
    try {
      expect((await runLostResponseRecovery(openEvalContext(dbB))).defect).toBe('D2');
    } finally {
      dbB.close();
    }
    const dbC = createDb(':memory:');
    try {
      expect((await runValidationEvidence(openEvalContext(dbC))).defect).toBe('D4');
    } finally {
      dbC.close();
    }
    const dbD = createDb(':memory:');
    try {
      expect((await runDiscoverTask(openEvalContext(dbD))).success).toBe(true);
    } finally {
      dbD.close();
    }
    const dbE = createDb(':memory:');
    try {
      expect((await runImpersonationRefused(dbE)).defect).toBe('D3');
    } finally {
      dbE.close();
    }
    const dbF = createDb(':memory:');
    try {
      expect((await runRateLimitPersistence(dbF)).defect).toBe('D1');
    } finally {
      dbF.close();
    }
  }, 120_000);
});

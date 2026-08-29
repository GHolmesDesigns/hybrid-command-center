/**
 * Agent-evaluation scoring (C134 / #384).
 *
 * Metrics follow the Codex report's guidance: task success, evidence completeness, latency, and
 * approximate token use — not call count alone. Deterministic scenarios set these; they do not
 * measure model quality.
 */

export type EvalClaimState = 'verified' | 'failed' | 'skipped';

export type EvalScenarioResult = {
  id: string;
  title: string;
  /** Maps to a §2 defect when the scenario is the pre-fix failure case for that defect. */
  defect?: 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
  success: boolean;
  evidenceComplete: boolean;
  latencyMs: number;
  /** Rough token estimate: UTF-8 payload characters / 4. */
  approxTokens: number;
  detail: string;
};

export type EvalRunSummary = {
  ranAt: string;
  results: EvalScenarioResult[];
  totals: {
    scenarios: number;
    succeeded: number;
    evidenceComplete: number;
    latencyMs: number;
    approxTokens: number;
  };
};

export function approxTokensFromPayloads(...payloads: unknown[]): number {
  let chars = 0;
  for (const payload of payloads) {
    chars += Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
  }
  return Math.ceil(chars / 4);
}

export function summarizeEvalRun(
  results: readonly EvalScenarioResult[],
  ranAt = new Date().toISOString(),
): EvalRunSummary {
  return {
    ranAt,
    results: [...results],
    totals: {
      scenarios: results.length,
      succeeded: results.filter((result) => result.success).length,
      evidenceComplete: results.filter((result) => result.evidenceComplete).length,
      latencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
      approxTokens: results.reduce((sum, result) => sum + result.approxTokens, 0),
    },
  };
}

export function renderFixtureMatrix(summary: EvalRunSummary): string {
  const date = new Date(summary.ranAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const lines = [
    `### Fixture evaluation matrix — ${date}`,
    '',
    '| Scenario | Defect | Success | Evidence | Latency (ms) | ≈Tokens | Detail |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
    ...summary.results.map((result) => {
      const defect = result.defect ?? '—';
      const success = result.success ? 'pass' : 'fail';
      const evidence = result.evidenceComplete ? 'complete' : 'incomplete';
      return `| ${escapeCell(result.title)} | ${defect} | **${success}** | ${evidence} | ${result.latencyMs} | ${result.approxTokens} | ${escapeCell(result.detail)} |`;
    }),
    '',
    `Totals: ${summary.totals.succeeded}/${summary.totals.scenarios} succeeded; ${summary.totals.evidenceComplete} with complete evidence; ${summary.totals.latencyMs} ms; ≈${summary.totals.approxTokens} tokens.`,
  ];
  return `${lines.join('\n')}\n`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

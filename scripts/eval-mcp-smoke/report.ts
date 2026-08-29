import type { EvalSmokeConfig } from './config.ts';
import type { EvalSmokeResult } from './smoke.ts';

export function renderEvalSmokePlan(config: EvalSmokeConfig): string {
  return [
    `Mode: ${config.mode}. ${config.mode === 'plan' ? 'Nothing will be contacted.' : 'Owner-approved read-only diagnostic will run.'}`,
    `Base URL: ${config.baseUrl}`,
    'Flow: operator login → POST /api/mcp/health/test → assert discovery checks, one resource read, and workspaceChecksumUnchanged.',
    'Writes: none. No coordination, workspace, Signal, or integration write tool is called.',
  ].join('\n');
}

export function renderEvalSmokeMatrix(result: EvalSmokeResult, now: Date): string {
  const date = now.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const lines = [
    `### Production smoke matrix — ${date}`,
    '',
    '| Claim | Result | Evidence |',
    '| --- | --- | --- |',
    ...result.claims.map(
      (claim) =>
        `| ${claim.claim.replaceAll('|', '\\|')} | **${claim.state}** | ${claim.evidence.replaceAll('|', '\\|')} |`,
    ),
    '',
    `Latency: ${result.latencyMs} ms.`,
  ];
  if (result.stopped) lines.push(`Stopped: ${result.stopped}`);
  return `${lines.join('\n')}\n`;
}

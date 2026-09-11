/* v8 ignore file -- entry point wiring argv and stdin to tested modules */
/**
 * Owner-run contract probe for provider-reported agent usage (C217).
 *
 * ```sh
 * npm run probe:agent-cost -- --probe-label hcc-cost-probe-0911
 * CURSOR_ADMIN_API_KEY=… npm run probe:agent-cost -- --live --yes --probe-label hcc-cost-probe-0911
 * ```
 *
 * Plans by default. Live mode contacts the configured Cursor admin usage endpoint, validates the
 * response with the same Zod rules as production, and prints a dated result matrix for the owner
 * transcript. Never CI.
 */
import { createInterface } from 'node:readline/promises';
import { CursorCostProvider } from '../server/agent-cost/cursor-cost.ts';
import { parseProbeArgs, PROBE_USAGE, renderPlan } from './probe-agent-cost/config.ts';

const outcome = parseProbeArgs(process.argv.slice(2), process.env);

if (process.argv.includes('--help')) {
  console.log(PROBE_USAGE);
  process.exit(0);
}

if (!outcome.config) {
  console.error(PROBE_USAGE);
  for (const refusal of outcome.refusals) console.error(`Refused: ${refusal}`);
  process.exit(1);
}

const config = outcome.config;
console.log(renderPlan(config, outcome.notices));
console.log('');

if (config.mode === 'plan') {
  console.log('Plan only. Nothing was contacted.');
  process.exit(0);
}

const readline = createInterface({ input: process.stdin, output: process.stdout });
const typed = (
  await readline.question(`Type the probe label to confirm (${config.probeLabel}): `)
).trim();
readline.close();
if (typed !== config.probeLabel) {
  console.error('Not confirmed. Nothing was contacted.');
  process.exit(1);
}

try {
  const provider = new CursorCostProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const listed = await provider.list();
  console.log('Validated provider rows:', listed.records.length);
  for (const record of listed.records.slice(0, 5)) {
    console.log(
      `- ${record.agentLabel ?? 'unassigned'} ${record.model}: ${record.quantity} ${record.unit} (${record.windowStart} – ${record.windowEnd})`,
    );
  }
  if (listed.warnings.length) {
    console.log('Warnings:');
    for (const warning of listed.warnings) console.log(`  - ${warning}`);
  }
  console.log('');
  console.log('Append this dated result to the C217 owner transcript. Do not commit credentials.');
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

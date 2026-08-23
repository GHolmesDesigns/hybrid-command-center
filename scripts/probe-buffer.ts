/* v8 ignore file -- the entry point only wires tested modules to argv, stdin, and fetch. */
import { createInterface } from 'node:readline/promises';
import { RequestBudget } from './probe-post-bridge/budget.ts';
import { BufferProbeClient, fetchBufferTransport } from './probe-buffer/client.ts';
import {
  BUFFER_PROBE_STOP_CONDITIONS,
  BUFFER_PROBE_USAGE,
  parseBufferProbeArgs,
} from './probe-buffer/config.ts';
import { runBufferProbe } from './probe-buffer/probe.ts';
import { renderBufferMatrix, renderBufferPlan } from './probe-buffer/report.ts';

const now = new Date();
const outcome = parseBufferProbeArgs(process.argv.slice(2), process.env, now);

if (process.argv.includes('--help')) {
  console.log(BUFFER_PROBE_USAGE);
  process.exit(0);
}
if (!outcome.config) {
  console.error(BUFFER_PROBE_USAGE);
  for (const refusal of outcome.refusals) console.error(`Refused: ${refusal}`);
  process.exit(1);
}

const config = outcome.config;
console.log('Owner stop conditions:');
for (const condition of BUFFER_PROBE_STOP_CONDITIONS) console.log(`  - ${condition}`);
console.log('');
console.log(renderBufferPlan(config));

if (config.mode === 'plan') {
  console.log('\nPlan only. Nothing was contacted.');
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

const result = await runBufferProbe({
  config,
  client: new BufferProbeClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    transport: fetchBufferTransport(),
    budget: new RequestBudget(),
  }),
});
console.log(`\n${renderBufferMatrix(result, now)}`);
for (const leftover of result.leftovers) console.error(`LEFTOVER ${leftover}`);
console.log('Commit only the reviewed matrix, never the transcript or credential.');
process.exit(result.stopped || result.leftovers.length ? 1 : 0);

/* v8 ignore file -- the entry point only wires tested modules to argv and fetch. */
import {
  EVAL_SMOKE_STOP_CONDITIONS,
  EVAL_SMOKE_USAGE,
  parseEvalSmokeArgs,
} from './eval-mcp-smoke/config.ts';
import { renderEvalSmokeMatrix, renderEvalSmokePlan } from './eval-mcp-smoke/report.ts';
import { runEvalMcpSmoke } from './eval-mcp-smoke/smoke.ts';
import { fetchEvalSmokeTransport } from './eval-mcp-smoke/transport.ts';

const now = new Date();
const outcome = parseEvalSmokeArgs(process.argv.slice(2), process.env);

if (process.argv.includes('--help')) {
  console.log(EVAL_SMOKE_USAGE);
  process.exit(0);
}
if (!outcome.config) {
  console.error(EVAL_SMOKE_USAGE);
  for (const refusal of outcome.refusals) console.error(`Refused: ${refusal}`);
  process.exit(1);
}

const config = outcome.config;
console.log('Owner stop conditions:');
for (const condition of EVAL_SMOKE_STOP_CONDITIONS) console.log(`  - ${condition}`);
console.log('');
console.log(renderEvalSmokePlan(config));

if (config.mode === 'plan') {
  console.log('\nPlan only. Nothing was contacted.');
  process.exit(0);
}

const result = await runEvalMcpSmoke({
  config,
  transport: fetchEvalSmokeTransport(config.baseUrl),
});
console.log(`\n${renderEvalSmokeMatrix(result, now)}`);
console.log('Commit only the reviewed matrix, never the transcript or password.');
process.exit(result.stopped ? 1 : 0);

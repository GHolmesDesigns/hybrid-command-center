/* v8 ignore file -- the entry point wires the tested modules to argv, stdin, the filesystem, and the live transport; everything it composes is measured where it lives. */
/**
 * A one-session contract probe against the live Post Bridge API.
 *
 * ```sh
 * # Plan the run. Contacts nothing, prints the mutations and the result matrix it would produce.
 * npm run probe:post-bridge -- --scheduled-at 2026-08-25T14:00:00Z --probe-label hcc-probe-0825 \
 *   --account linkedin:101 --account linkedin:102
 *
 * # Run it. Needs the key in the environment, --yes, --accounts-approved, and a typed confirmation.
 * POST_BRIDGE_API_KEY=… npm run probe:post-bridge -- --live --yes --accounts-approved \
 *   --scheduled-at 2026-08-25T14:00:00Z --probe-label hcc-probe-0825 \
 *   --account linkedin:101 --account linkedin:102 --video ./disposable.mp4
 * ```
 *
 * It writes scheduled posts to the accounts named on the command line and deletes them again. It
 * never publishes, never posts instantly, never touches a post it did not create, and never uploads
 * anything but the committed fixtures or the disposable file passed to `--video`. What it learns goes
 * to standard output as a dated result matrix for
 * `docs/post-bridge-api-surface.md`; the transcript stays on the operator's terminal and is not
 * committed.
 *
 * Card C73 of `docs/post-bridge-integrations-plan.md`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { RequestBudget } from './probe-post-bridge/budget.ts';
import { ProbeClient } from './probe-post-bridge/client.ts';
import { parseProbeArgs, PROBE_STOP_CONDITIONS, PROBE_USAGE } from './probe-post-bridge/config.ts';
import { loadProbeFixtures } from './probe-post-bridge/fixtures.ts';
import { runProbe } from './probe-post-bridge/probe.ts';
import {
  probeMatrixDate,
  renderPlan,
  renderResultMatrix,
  unrunResult,
} from './probe-post-bridge/report.ts';
import { fetchTransport } from './probe-post-bridge/transport.ts';

const now = new Date();
const outcome = parseProbeArgs(process.argv.slice(2), process.env, now);

if (process.argv.includes('--help')) {
  console.log(PROBE_USAGE);
  console.log('');
  console.log('Stop conditions — these are yours to check, not the script’s:');
  for (const condition of PROBE_STOP_CONDITIONS) console.log(`  - ${condition}`);
  process.exit(0);
}

if (!outcome.config) {
  console.error(PROBE_USAGE);
  console.error('');
  for (const refusal of outcome.refusals) console.error(`Refused: ${refusal}`);
  process.exit(1);
}

const config = outcome.config;
const fixturesDirectory = join(import.meta.dirname, 'fixtures');
const fixtures = loadProbeFixtures({
  readFile: (path) =>
    readFileSync(path.includes('/') || path.includes('\\') ? path : join(fixturesDirectory, path)),
  ...(config.videoPath === undefined ? {} : { videoPath: config.videoPath }),
});

console.log('Stop conditions — these are yours to check, not the script’s:');
for (const condition of PROBE_STOP_CONDITIONS) console.log(`  - ${condition}`);
console.log('');
console.log(renderPlan(config, fixtures, outcome.notices));
console.log('');

if (config.mode === 'plan') {
  console.log(
    'Plan only. Nothing was contacted. The matrix a session appends to docs/post-bridge-api-surface.md:',
  );
  console.log('');
  console.log(renderResultMatrix(unrunResult(fixtures), { date: probeMatrixDate(now) }));
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

const result = await runProbe({
  client: new ProbeClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    transport: fetchTransport(),
    budget: new RequestBudget(),
  }),
  config,
  fixtures,
  now,
});

console.log('');
console.log(renderResultMatrix(result, { date: probeMatrixDate(now) }));
console.log('');
console.log(
  `Requests: ${result.budget.used} of ${result.budget.total}. Posts created ${result.teardown.createdPosts.length}, deleted ${result.teardown.deletedPosts.length}. Inventory proof: ${result.teardown.inventory}.`,
);
if (result.stopped) console.error(`The run stopped early: ${result.stopped}`);
for (const leftover of result.leftovers)
  console.error(`LEFTOVER ${leftover.kind} ${leftover.providerId}: ${leftover.note}`);
console.log('');
console.log(
  'Append the matrix above under the existing sections of docs/post-bridge-api-surface.md. Commit the matrix, never this transcript.',
);
process.exit(result.leftovers.length || result.stopped ? 1 : 0);

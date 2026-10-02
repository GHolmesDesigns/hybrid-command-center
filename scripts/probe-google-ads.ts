/* v8 ignore file -- CLI wiring; transport and guards are tested separately. */
import { createInterface } from 'node:readline/promises';
import {
  parseAdsProbeArgs,
  renderAdsPlan,
  runAdsProbe,
  type AdsTransport,
} from './probe-google-ads/core.ts';

const parsed = parseAdsProbeArgs(process.argv.slice(2), process.env);
if (parsed.help) {
  console.log(renderAdsPlan());
  process.exit(0);
}
if (parsed.error) {
  console.error(`Refused: ${parsed.error}`);
  process.exit(1);
}
console.log(renderAdsPlan());
if (!parsed.live) {
  console.log('Plan only. Nothing was contacted.');
  process.exit(0);
}
const readline = createInterface({ input: process.stdin, output: process.stdout });
const answer = await readline.question('Type LIVE to confirm the approved account read: ');
readline.close();
if (answer.trim() !== 'LIVE') {
  console.error('Not confirmed. Nothing was contacted.');
  process.exit(1);
}
const transport: AdsTransport = (url, init) => fetch(url, init);
try {
  const result = await runAdsProbe(parsed.config!, transport);
  console.log(
    `Completed ${result.requests} HTTP requests; directly accessible accounts: ${result.accessibleCount}; approved account present: ${result.approvedAccountPresent}; metadata rows: ${result.metadataRows}; campaign rows: ${result.campaignRows}; dated metric rows: ${result.metricRows}.`,
  );
  console.log(
    'Empty rows prove only query acceptance, not populated values. Save any owner transcript outside the repository.',
  );
} catch (error) {
  console.error(`Probe stopped: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}

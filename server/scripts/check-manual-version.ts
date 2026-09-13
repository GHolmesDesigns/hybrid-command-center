/**
 * Fails when the operating manual's current-version stamps disagree with `package.json`.
 * The manual is a hand-maintained compilation and nothing else fails red when it falls
 * behind — it once sat at 5.4.0 through four releases before anyone noticed.
 *
 * Only four of the manual's version mentions are checked, not every one. The manual also
 * carries historical attributions — "5.4.2 splits that runbook into two columns", "pinned
 * by tests since 5.4.1" — which correctly keep their original version forever and must
 * never be bumped. Those read exactly like a current-version stamp to a general "find a
 * version number near this word" pattern: same shape, opposite lifecycle. The four checked
 * here are the ones with no historical reading at all, each anchored to markup that exists
 * for exactly one purpose (the sidebar credit, the release badge, the stats row, the page
 * footer) rather than to prose a future rewrite could turn into an attribution. A fifth
 * candidate — the sentence describing what the MCP surface currently offers — was left out
 * on purpose: nearby prose in the same style ("5.5.0 makes the write budget per credential")
 * is a historical attribution that must NOT move, and nothing short of reading the sentence
 * for meaning tells them apart. A narrow gate that is always right beats a broad one that
 * cries wolf.
 */
import { readFileSync } from 'node:fs';

const MANUAL_PATH = 'docs/manual/hybrid-command-center-manual.html';
const VERSION = String.raw`(\d+\.\d+\.\d+)`;

interface Stamp {
  name: string;
  pattern: RegExp;
}

const STAMPS: Stamp[] = [
  {
    name: 'rail footer',
    pattern: new RegExp(`<div class="railfoot">[\\s\\S]*?Version ${VERSION}<br`),
  },
  {
    name: 'masthead badge',
    pattern: new RegExp(`<span class="draft">Release ${VERSION}</span>`),
  },
  {
    name: 'stats block',
    pattern: new RegExp(`<dl class="stats">[\\s\\S]*?<dt>Version</dt>\\s*<dd>${VERSION}</dd>`),
  },
  {
    name: 'colophon',
    pattern: new RegExp(`Hybrid Command Center ${VERSION} &mdash; operating manual`),
  },
];

const fail: (message: string) => never = (message) => {
  console.error(`check:manual-version failed — ${message}`);
  process.exit(1);
};

const skip: (reason: string) => never = (reason) => {
  console.log(`check:manual-version skipped — ${reason}`);
  process.exit(0);
};

const prLabels =
  process.env.HCC_PR_LABELS?.split(',')
    .map((label) => label.trim())
    .filter(Boolean) ?? [];

if (prLabels.includes('no-version-bump')) {
  skip('pull request carries no-version-bump; manual stamps are unchanged.');
}

let manual: string;
try {
  manual = readFileSync(MANUAL_PATH, 'utf8');
} catch {
  fail(`could not read ${MANUAL_PATH}.`);
}

const appVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;

const missing: string[] = [];
const stale: { name: string; found: string }[] = [];

for (const stamp of STAMPS) {
  const match = stamp.pattern.exec(manual);
  if (!match) {
    missing.push(stamp.name);
    continue;
  }
  if (match[1] !== appVersion) {
    stale.push({ name: stamp.name, found: match[1] });
  }
}

if (missing.length > 0) {
  fail(
    `could not find the ${missing.join(', ')} stamp${missing.length > 1 ? 's' : ''} in ${MANUAL_PATH}. ` +
      'Either the manual was restructured (update the patterns in check-manual-version.ts) or ' +
      'a stamp was deleted (restore it).',
  );
}

if (stale.length > 0) {
  fail(
    `package.json is ${appVersion}, but the manual's ${stale.map((s) => `${s.name} (${s.found})`).join(', ')} ` +
      `${stale.length > 1 ? 'say' : 'says'} otherwise. Update ${MANUAL_PATH} to ${appVersion} as part of finalization.`,
  );
}

console.log(`check:manual-version passed — the manual's stamps agree with ${appVersion}.`);

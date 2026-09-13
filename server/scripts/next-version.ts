/**
 * Prints the next semver for a card about to finalize against origin/main.
 *
 * Usage:
 *   npm run version:next
 *   npm run version:next -- --milestone "Wave 40 — Operator workflow and UI polish"
 *   npm run version:next -- --minor
 *   npm run version:next -- --patch
 */
import { resolveNextVersion, tryGit } from './version-utils.ts';

const args = process.argv.slice(2);
const milestoneIdx = args.indexOf('--milestone');
const milestone = milestoneIdx >= 0 && args[milestoneIdx + 1] ? args[milestoneIdx + 1] : undefined;
const forceMinor = args.includes('--minor');
const forcePatch = args.includes('--patch');

if (forceMinor && forcePatch) {
  console.error('next-version: pass only one of --minor or --patch.');
  process.exit(1);
}

if (!tryGit('rev-parse', '--git-dir')) {
  console.error('next-version: not a Git checkout.');
  process.exit(1);
}

tryGit('fetch', 'origin', 'main');

const result = resolveNextVersion({
  baseRef: 'origin/main',
  milestone,
  forceMinor,
  forcePatch,
});

console.log(
  `next-version: ${result.nextVersion} (${result.bumpKind} bump; origin/main is ${result.baseVersion})`,
);
console.log(result.nextVersion);

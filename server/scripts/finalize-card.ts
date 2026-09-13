/**
 * Atomic release finalization for one card: version, branding, manual stamps, changelog.
 *
 * Usage:
 *   npm run finalize:card -- 638
 *   npm run finalize:card -- 638 --version 6.9.1
 *   npm run finalize:card -- 638 --milestone "Wave 40 — Operator workflow and UI polish"
 *   npm run finalize:card -- 638 --no-rebase
 *
 * Does not push. Review the commit, then push and mark the pull request ready.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolveNextVersion, tryGit } from './version-utils.ts';

const MANUAL_PATH = 'docs/manual/hybrid-command-center-manual.html';
const CHANGELOG_PATH = 'CHANGELOG.md';
const BRANDING_PATH = 'shared/branding.ts';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-') || arg === '--');
const flags = process.argv.slice(2);

const issueArg = args.find((arg) => /^\d+$/.test(arg));
if (!issueArg) {
  console.error(
    'finalize-card: pass an issue number, e.g. npm run finalize:card -- 638 [--version X.Y.Z]',
  );
  process.exit(1);
}

const issue = issueArg;
const noRebase = flags.includes('--no-rebase');
const versionIdx = flags.indexOf('--version');
const explicitVersion =
  versionIdx >= 0 && flags[versionIdx + 1] ? flags[versionIdx + 1] : undefined;
const milestoneIdx = flags.indexOf('--milestone');
const milestone =
  milestoneIdx >= 0 && flags[milestoneIdx + 1] ? flags[milestoneIdx + 1] : undefined;
const forceMinor = flags.includes('--minor');
const forcePatch = flags.includes('--patch');

const fragmentPath = `changes/${issue}.md`;
if (!existsSync(fragmentPath)) {
  console.error(`finalize-card: missing ${fragmentPath}.`);
  process.exit(1);
}

if (!tryGit('rev-parse', '--git-dir')) {
  console.error('finalize-card: not a Git checkout.');
  process.exit(1);
}

const status = tryGit('status', '--porcelain', '--untracked-files=no');
if (status) {
  console.error('finalize-card: working tree is not clean. Commit or stash changes first.');
  console.error(status);
  process.exit(1);
}

console.log('finalize-card: fetching origin/main…');
tryGit('fetch', 'origin', 'main');

if (!noRebase) {
  console.log('finalize-card: rebasing onto origin/main…');
  execFileSync('git', ['rebase', 'origin/main'], { stdio: 'inherit' });
}

const version =
  explicitVersion ??
  resolveNextVersion({
    baseRef: 'origin/main',
    milestone,
    forceMinor,
    forcePatch,
  }).nextVersion;

console.log(`finalize-card: assigning ${version}…`);

execFileSync('npm', ['version', version, '--no-git-tag-version'], { stdio: 'inherit' });

const branding = readFileSync(BRANDING_PATH, 'utf8');
const brandingNext = branding.replace(
  /export const APP_VERSION = '[^']+';/,
  `export const APP_VERSION = '${version}';`,
);
if (brandingNext === branding) {
  console.error(`finalize-card: could not update APP_VERSION in ${BRANDING_PATH}.`);
  process.exit(1);
}
writeFileSync(BRANDING_PATH, brandingNext);

const manual = readFileSync(MANUAL_PATH, 'utf8');
const stampPatterns: { label: string; pattern: RegExp }[] = [
  {
    label: 'rail footer',
    pattern: /(<div class="railfoot">[\s\S]*?Version )(\d+\.\d+\.\d+)(<br)/,
  },
  {
    label: 'masthead badge',
    pattern: /(<span class="draft">Release )(\d+\.\d+\.\d+)(<\/span>)/,
  },
  {
    label: 'stats block',
    pattern: /(<dl class="stats">[\s\S]*?<dt>Version<\/dt>\s*<dd>)(\d+\.\d+\.\d+)(<\/dd>)/,
  },
  {
    label: 'colophon',
    pattern: /(Hybrid Command Center )(\d+\.\d+\.\d+)( &mdash; operating manual)/,
  },
];

let manualNext = manual;
for (const stamp of stampPatterns) {
  if (!stamp.pattern.test(manualNext)) {
    console.error(`finalize-card: could not find ${stamp.label} stamp in ${MANUAL_PATH}.`);
    process.exit(1);
  }
  manualNext = manualNext.replace(
    stamp.pattern,
    (_match, prefix: string, _oldVersion: string, suffix: string) => `${prefix}${version}${suffix}`,
  );
}
writeFileSync(MANUAL_PATH, manualNext);

const fragment = readFileSync(fragmentPath, 'utf8').trim();
const today = new Date().toISOString().slice(0, 10);
const entry = `## [${version}] - ${today}\n\n${fragment}\n`;
const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
const heading = '# Changelog\n\n';
if (!changelog.startsWith(heading)) {
  console.error(`finalize-card: ${CHANGELOG_PATH} does not start with expected heading.`);
  process.exit(1);
}
writeFileSync(CHANGELOG_PATH, heading + entry + changelog.slice(heading.length));
unlinkSync(fragmentPath);

console.log('finalize-card: running check:version-bump and check:manual-version…');
execFileSync('npm', ['run', 'check:version-bump'], { stdio: 'inherit' });
execFileSync('npm', ['run', 'check:manual-version'], { stdio: 'inherit' });

execFileSync(
  'git',
  ['add', 'package.json', 'package-lock.json', BRANDING_PATH, MANUAL_PATH, CHANGELOG_PATH],
  {
    stdio: 'inherit',
  },
);
execFileSync('git', ['add', '-u', 'changes'], { stdio: 'inherit' });
execFileSync('git', ['commit', '-m', `chore: finalize release ${version} (#${issue})`], {
  stdio: 'inherit',
});

console.log(
  `finalize-card: done — committed ${version} for #${issue}. Push, then mark the PR ready.`,
);

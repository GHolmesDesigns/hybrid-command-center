// Housekeeping inventory: classifies every worktree, local branch, stash, open pull request, and
// disposable output in this repository, and prints the result as JSON. It changes nothing a person
// would notice — the only write is fetching a merged pull request's head commit into the object
// store when the ancestry check needs it. Every removal verdict lives here, in one place, so the
// rules are not re-derived by hand on each run.
//
// Run from any checkout of the repository, after `git fetch origin --prune`:
//   node --experimental-strip-types .claude/skills/housekeeping/scripts/inventory.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Verdict = 'remove' | 'keep' | 'decide';

interface PullRequest {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  url: string;
}

interface BranchReport {
  name: string;
  tip: string;
  upstream: string | null;
  upstreamGone: boolean;
  worktree: string | null;
  pullRequests: { number: number; state: string; url: string }[];
  verdict: Verdict;
  reason: string;
}

interface WorktreeReport {
  path: string;
  owner: 'primary' | 'repo' | 'claude' | 'codex' | 'external';
  branch: string | null;
  head: string;
  isCurrent: boolean;
  locked: boolean;
  prunable: boolean;
  changes: string[];
  verdict: Verdict;
  reason: string;
}

const CARD_BRANCH = /^(feat|fix|chore|docs)\/(\d+)-[a-z0-9]+(-[a-z0-9]+)*$/;
const DISPOSABLE = ['test-results', 'playwright-report', 'coverage'];

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

function git(args: string[], cwd?: string): string {
  return run('git', args, cwd);
}

function gitSucceeds(args: string[], cwd?: string): boolean {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const currentTop = git(['rev-parse', '--show-toplevel']);
const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
const primaryPath = normalize(commonDir).replace(/\/\.git$/, '');

let ghAvailable = true;
let ghError = '';
function gh(args: string[]): unknown {
  if (!ghAvailable) return null;
  try {
    return JSON.parse(run('gh', args, currentTop));
  } catch (error) {
    ghAvailable = false;
    ghError = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return null;
  }
}

// ── Worktrees ────────────────────────────────────────────────────────────────────────────────

interface RawWorktree {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

const rawWorktrees: RawWorktree[] = [];
for (const block of git(['worktree', 'list', '--porcelain']).split(/\n\n+/)) {
  const lines = block.split('\n');
  const entry: RawWorktree = { path: '', head: '', branch: null, locked: false, prunable: false };
  for (const line of lines) {
    if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length);
    else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) entry.branch = line.slice('branch refs/heads/'.length);
    else if (line.startsWith('locked')) entry.locked = true;
    else if (line.startsWith('prunable')) entry.prunable = true;
  }
  if (entry.path) rawWorktrees.push(entry);
}

function ownerOf(path: string): WorktreeReport['owner'] {
  const p = normalize(path);
  if (p === primaryPath) return 'primary';
  if (p.includes('/.claude/worktrees/')) return 'claude';
  if (p.includes('/.codex/worktrees/')) return 'codex';
  if (p.startsWith(`${primaryPath}/.worktrees/`)) return 'repo';
  return 'external';
}

function changesIn(path: string): string[] {
  if (!existsSync(path)) return [];
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], path);
  return status ? status.split('\n') : [];
}

const worktreeByBranch = new Map<string, RawWorktree>();
for (const wt of rawWorktrees) if (wt.branch) worktreeByBranch.set(wt.branch, wt);

// ── Pull requests ────────────────────────────────────────────────────────────────────────────

const prFields = 'number,state,isDraft,headRefOid,headRefName,url';

function pullRequestsFor(names: string[]): PullRequest[] | null {
  const found = new Map<number, PullRequest>();
  for (const name of names) {
    const list = gh([
      'pr',
      'list',
      '--head',
      name,
      '--state',
      'all',
      '--limit',
      '20',
      '--json',
      prFields,
    ]) as PullRequest[] | null;
    if (list === null) return null;
    // `--head` matches by branch name only; keep exact matches.
    for (const pr of list) if (pr.headRefName === name) found.set(pr.number, pr);
  }
  return [...found.values()].sort((a, b) => b.number - a.number);
}

function hasCommit(oid: string): boolean {
  return gitSucceeds(['cat-file', '-e', `${oid}^{commit}`]);
}

function ensureCommit(oid: string, prNumber: number): boolean {
  if (hasCommit(oid)) return true;
  gitSucceeds(['fetch', '--quiet', 'origin', `refs/pull/${prNumber}/head`]);
  return hasCommit(oid);
}

function contains(ancestor: string, descendant: string): boolean {
  return gitSucceeds(['merge-base', '--is-ancestor', ancestor, descendant]);
}

function commitsBeyond(base: string, tip: string): number {
  return Number(git(['rev-list', '--count', `${base}..${tip}`]));
}

// ── Branches ─────────────────────────────────────────────────────────────────────────────────

const branchLines = git([
  'for-each-ref',
  '--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(upstream:track)',
  'refs/heads',
]).split('\n');

const branches: BranchReport[] = [];
for (const line of branchLines.filter(Boolean)) {
  const [name, tip, upstreamRaw, track] = line.split('\t');
  if (name === 'main') continue;
  const upstream = upstreamRaw || null;
  const wt = worktreeByBranch.get(name) ?? null;
  const report: BranchReport = {
    name,
    tip,
    upstream,
    upstreamGone: track === '[gone]',
    worktree: wt?.path ?? null,
    pullRequests: [],
    verdict: 'keep',
    reason: '',
  };

  const headNames = [name];
  if (upstream?.startsWith('origin/')) {
    const remoteName = upstream.slice('origin/'.length);
    if (remoteName !== name && remoteName !== 'main') headNames.push(remoteName);
  }
  const prs = pullRequestsFor(headNames);
  if (prs === null) {
    report.verdict = 'decide';
    report.reason = `pull request state unknown: ${ghError}`;
    branches.push(report);
    continue;
  }
  report.pullRequests = prs.map((pr) => ({ number: pr.number, state: pr.state, url: pr.url }));

  const open = prs.find((pr) => pr.state === 'OPEN');
  const merged = prs.filter((pr) => pr.state === 'MERGED');
  const closed = prs.find((pr) => pr.state === 'CLOSED');

  if (open) {
    report.reason = `open pull request #${open.number}`;
  } else if (merged.length > 0) {
    const covering = merged.find(
      (pr) => ensureCommit(pr.headRefOid, pr.number) && contains(tip, pr.headRefOid),
    );
    if (covering) {
      report.verdict = 'remove';
      report.reason = `merged in #${covering.number}; every local commit is in it`;
    } else {
      const pr = merged[0];
      const extra = hasCommit(pr.headRefOid) ? commitsBeyond(pr.headRefOid, tip) : null;
      report.verdict = 'decide';
      report.reason =
        extra === null
          ? `merged in #${pr.number}, but its head commit could not be fetched to compare`
          : `merged in #${pr.number}, but ${extra} local commit(s) are not in it`;
    }
  } else if (closed) {
    report.verdict = 'decide';
    report.reason = `pull request #${closed.number} was closed without merging`;
  } else {
    report.reason = 'no pull request yet';
  }

  if (report.verdict === 'remove' && wt) {
    const changes = changesIn(wt.path);
    if (changes.length > 0) {
      report.verdict = 'decide';
      report.reason += `; its worktree has ${changes.length} uncommitted change(s)`;
    } else if (wt.locked) {
      report.verdict = 'decide';
      report.reason += '; its worktree is locked';
    } else if (normalize(wt.path) === primaryPath || normalize(wt.path) === normalize(currentTop)) {
      report.reason += `; checked out at ${wt.path} — switch that checkout to main first`;
    }
  }
  branches.push(report);
}

const branchVerdict = new Map(branches.map((b) => [b.name, b]));

// ── Worktree verdicts ────────────────────────────────────────────────────────────────────────

const worktrees: WorktreeReport[] = rawWorktrees.map((wt) => {
  const owner = ownerOf(wt.path);
  const isCurrent = normalize(wt.path) === normalize(currentTop);
  const changes = wt.prunable ? [] : changesIn(wt.path);
  const report: WorktreeReport = {
    path: wt.path,
    owner,
    branch: wt.branch,
    head: wt.head,
    isCurrent,
    locked: wt.locked,
    prunable: wt.prunable,
    changes,
    verdict: 'keep',
    reason: '',
  };

  if (owner === 'primary') report.reason = 'primary checkout';
  else if (isCurrent) report.reason = 'this session is running in it';
  else if (wt.prunable) {
    report.verdict = 'remove';
    report.reason = 'directory is gone; prune the stale entry';
  } else if (wt.locked) {
    report.verdict = 'decide';
    report.reason = 'locked';
  } else if (changes.length > 0) {
    report.verdict = 'decide';
    report.reason = `${changes.length} uncommitted change(s)`;
  } else if (wt.branch === 'main') {
    report.reason = 'main is checked out here';
  } else if (wt.branch) {
    const b = branchVerdict.get(wt.branch);
    report.verdict = b?.verdict === 'remove' ? 'remove' : (b?.verdict ?? 'keep');
    report.reason = b ? `branch ${wt.branch}: ${b.reason}` : `branch ${wt.branch}`;
  } else if (contains(wt.head, 'origin/main')) {
    report.verdict = 'remove';
    report.reason = 'detached at a commit already on origin/main';
  } else if (git(['branch', '-r', '--contains', wt.head])) {
    report.verdict = 'remove';
    report.reason = 'detached at a commit already on a remote branch';
  } else {
    report.verdict = 'decide';
    report.reason = 'detached at a commit no remote branch contains';
  }
  return report;
});

// ── main ─────────────────────────────────────────────────────────────────────────────────────

const mainWorktree = worktreeByBranch.get('main') ?? null;
const mainLocal = git(['rev-parse', 'main']);
const mainRemote = git(['rev-parse', 'origin/main']);
const main = {
  checkedOutAt: mainWorktree?.path ?? null,
  behind: commitsBeyond(mainLocal, mainRemote),
  ahead: commitsBeyond(mainRemote, mainLocal),
  fragmentsOnOriginMain: git(['ls-tree', '--name-only', 'origin/main', 'changes/'])
    .split('\n')
    .filter((p) => p.endsWith('.md')),
};

// ── Stashes ──────────────────────────────────────────────────────────────────────────────────

const stashes = git(['stash', 'list']).split('\n').filter(Boolean);

// ── Open pull requests and card hygiene ──────────────────────────────────────────────────────

interface OpenPr {
  number: number;
  title: string;
  headRefName: string;
  isDraft: boolean;
  url: string;
  labels: { name: string }[];
}

const cardFindings: string[] = [];
const openList = gh([
  'pr',
  'list',
  '--state',
  'open',
  '--limit',
  '50',
  '--json',
  'number,title,headRefName,isDraft,url,labels',
]) as OpenPr[] | null;

const openPullRequests = (openList ?? []).map((pr) => {
  const card = CARD_BRANCH.exec(pr.headRefName);
  const files =
    (gh(['pr', 'view', String(pr.number), '--json', 'files']) as { files: { path: string }[] })
      ?.files ?? [];
  const fragments = files.map((f) => f.path).filter((p) => /^changes\/[^/]+\.md$/.test(p));
  const noBump = pr.labels.some((l) => l.name === 'no-version-bump');
  if (card && pr.isDraft && !noBump && !fragments.includes(`changes/${card[2]}.md`)) {
    cardFindings.push(`Draft #${pr.number} (${pr.headRefName}) has no changes/${card[2]}.md.`);
  }
  if (!pr.isDraft && fragments.length > 0) {
    cardFindings.push(`Ready #${pr.number} still carries ${fragments.join(', ')}.`);
  }
  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    isDraft: pr.isDraft,
    url: pr.url,
    isCard: Boolean(card),
    fragments,
  };
});

const openCards = openPullRequests.filter((pr) => pr.isCard);
if (openCards.length > 1) {
  cardFindings.push(
    `${openCards.length} implementing pull requests are open (${openCards
      .map((pr) => `#${pr.number}`)
      .join(', ')}); AGENTS.md allows one.`,
  );
}
if (main.fragmentsOnOriginMain.length > 0) {
  cardFindings.push(`origin/main carries fragments: ${main.fragmentsOnOriginMain.join(', ')}.`);
}
for (const b of branches) {
  if (b.verdict === 'remove' || b.name.startsWith('dependabot/')) continue;
  if (!CARD_BRANCH.test(b.name)) {
    cardFindings.push(`Branch ${b.name} does not follow <type>/<issue>-<slug>.`);
  }
}
if (openList === null) cardFindings.push(`Open pull requests could not be read: ${ghError}`);

// ── Disposable outputs ───────────────────────────────────────────────────────────────────────

// Only the primary checkout and this one: another session's worktree may be mid-run, and its
// outputs leave with it when the worktree itself is removed.
const disposables: string[] = [];
for (const wt of worktrees) {
  if (wt.owner !== 'primary' && !wt.isCurrent) continue;
  if (!existsSync(wt.path)) continue;
  const candidates = [
    ...DISPOSABLE,
    ...readdirSync(wt.path).filter((entry) => entry.startsWith('.tmp-')),
  ];
  for (const entry of candidates) {
    const full = join(wt.path, entry);
    if (!existsSync(full)) continue;
    // Only ever offer what git itself ignores, so nothing tracked can be listed here.
    const probe = statSync(full).isDirectory() ? `${entry}/` : entry;
    if (gitSucceeds(['check-ignore', '-q', probe], wt.path)) {
      disposables.push(full.replace(/\\/g, '/'));
    }
  }
}

console.log(
  JSON.stringify(
    {
      currentCheckout: currentTop,
      githubReadable: ghAvailable,
      main,
      worktrees,
      branches,
      stashes,
      openPullRequests,
      cardFindings,
      disposables,
    },
    null,
    2,
  ),
);

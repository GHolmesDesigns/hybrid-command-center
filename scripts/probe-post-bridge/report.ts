/**
 * Two pieces of writing: the plan a person reads before saying yes, and the dated result matrix that
 * is the only part of a session anyone commits.
 *
 * The matrix is generated rather than typed. Every claim in the registry gets exactly one row and
 * exactly one state, the disposition column is computed from that state, and a claim nothing
 * answered says so — which is what makes "never silently convert still unverified into permission to
 * build" a property of the code instead of a thing to remember while editing a table.
 */
import {
  CLAIM_STATE_LABEL,
  claimDisposition,
  initialClaims,
  PROBE_QUESTIONS,
  type ProbeClaimResult,
} from './claims.ts';
import { PROBE_REQUEST_BUDGET, PROBE_TEARDOWN_RESERVE } from './budget.ts';
import type { ProbeConfig } from './config.ts';
import { fixtureRecord, type ProbeFixture, type ProbeFixtureKey } from './fixtures.ts';
import type { ProbeRunResult } from './probe.ts';

/** The heading the matrix is found under, in the findings note and in the test that checks it. */
export const RESULT_MATRIX_HEADING = '## 14. Live probe result matrix';

/** A table cell: pipes escaped, newlines flattened, so one row stays one row. */
function cell(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * The plan, read out before the final confirmation.
 *
 * It names every account by platform and provider id and every mutation the run intends, because the
 * thing a person is agreeing to is a list of writes against real accounts. The handle is deliberately
 * absent: the id is what the request carries, and an account name is content this script has no
 * reason to hold.
 */
export function renderPlan(
  config: ProbeConfig,
  fixtures: Map<ProbeFixtureKey, ProbeFixture>,
  notices: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(
    `Mode: ${config.mode === 'live' ? 'LIVE — this writes to the accounts below' : 'plan only — nothing is contacted'}`,
  );
  lines.push(`Base URL: ${config.baseUrl}`);
  lines.push(`Probe label: ${config.probeLabel}`);
  lines.push(`Scheduled at: ${config.scheduledAt}`);
  lines.push(
    `Request budget: ${PROBE_REQUEST_BUDGET} in total, of which ${PROBE_TEARDOWN_RESERVE} are reserved for teardown.`,
  );
  lines.push('');
  lines.push('Accounts this run will write to:');
  for (const account of config.accounts)
    lines.push(`  - ${account.platform} account ${account.accountId}`);
  lines.push('');
  lines.push('Fixtures it may upload:');
  for (const fixture of fixtures.values())
    lines.push(
      `  - ${fixture.name} (${fixture.mimeType}, ${fixture.sizeBytes} bytes, sha256 ${fixture.sha256})`,
    );
  lines.push('');
  lines.push('Mutations it intends:');
  lines.push('  - reserve an upload URL and PUT each fixture above');
  lines.push('  - create up to five scheduled posts, every one of them carrying the probe label');
  lines.push('  - PATCH one of them once, always sending scheduled_at');
  lines.push('  - DELETE every post it created, and every asset it uploaded, in a finally block');
  lines.push('  - re-read the complete post inventory afterwards to prove the deletions');
  lines.push('');
  lines.push('It will not: publish anything, post instantly, touch a post it did not create,');
  lines.push('upload a customer asset, or retry after a 429.');
  if (notices.length) {
    lines.push('');
    lines.push('Questions this invocation cannot answer:');
    for (const notice of notices) lines.push(`  - ${notice}`);
  }
  return lines.join('\n');
}

/** The state a run is in before it has done anything, so the committed matrix can be honest. */
export function unrunResult(fixtures: Map<ProbeFixtureKey, ProbeFixture>): ProbeRunResult {
  return {
    claims: initialClaims(),
    calls: [],
    budget: { used: 0, total: PROBE_REQUEST_BUDGET, reserve: PROBE_TEARDOWN_RESERVE },
    fixtures: [...fixtures.values()].map(fixtureRecord),
    teardown: {
      createdPosts: [],
      deletedPosts: [],
      failedPosts: [],
      deletedMedia: [],
      undeletableMedia: [],
      inventory: 'not-verified',
      inventoryNote: 'No session has run, so there was nothing to delete and nothing to prove.',
    },
    leftovers: [],
  };
}

function claimRows(claims: readonly ProbeClaimResult[], question: number): string[] {
  return claims
    .filter((claim) => claim.question === question)
    .map(
      (claim) =>
        `| ${cell(claim.claim)} | **${CLAIM_STATE_LABEL[claim.state]}** | ${cell(
          claim.evidence.join(' '),
        )} | ${cell(claimDisposition(claim))} |`,
    );
}

/**
 * The whole section, ready to append to the findings note.
 *
 * `date` is passed in rather than read from a clock: this string is committed, and a generated
 * document that changes every time it is regenerated is a document nobody can diff.
 */
export function renderResultMatrix(result: ProbeRunResult, options: { date: string }): string {
  const lines: string[] = [];
  const ran = result.calls.length > 0;
  lines.push(`${RESULT_MATRIX_HEADING} — ${options.date}`);
  lines.push('');
  if (!ran) {
    lines.push(
      '**No live session has been run.** `scripts/probe-post-bridge.ts` and its fixtures are in the',
    );
    lines.push(
      'repository and its guards, request shapes, redaction, budget, and teardown are covered by tests,',
    );
    lines.push(
      'but every claim below is still exactly as unverified as it was before the script existed. The',
    );
    lines.push(
      'table is generated by the script itself so that the day it does run, the matrix is the run rather',
    );
    lines.push('than somebody’s summary of it.');
  } else {
    lines.push(
      `Session ran with ${result.budget.used} of ${result.budget.total} allowed requests (${result.budget.reserve} of them reserved for teardown).`,
    );
    if (result.stopped) lines.push('');
    if (result.stopped) lines.push(`**The run stopped early:** ${result.stopped}`);
  }
  lines.push('');
  lines.push(
    'Four states, and no fifth: **verified**, **verified with policy constraint**, **negative**, and',
  );
  lines.push('**still unverified**. Its reviewed registry disposition remains authoritative: it');
  lines.push('blocks dependent work unless that work has an explicit path that cannot rely on it.');
  lines.push('');

  lines.push('### Fixtures');
  lines.push('');
  lines.push('| Fixture | Type | Bytes | sha256 |');
  lines.push('| --- | --- | --- | --- |');
  for (const fixture of result.fixtures)
    lines.push(
      `| \`${fixture.name}\` | \`${fixture.mimeType}\` | ${fixture.sizeBytes} | \`${fixture.sha256}\` |`,
    );
  lines.push('');

  lines.push('### Teardown');
  lines.push('');
  lines.push(
    `- Posts created: ${result.teardown.createdPosts.length}; deleted: ${result.teardown.deletedPosts.length}.`,
  );
  lines.push(
    `- Provider assets created: ${result.teardown.deletedMedia.length + result.teardown.undeletableMedia.length}; deleted: ${result.teardown.deletedMedia.length}.`,
  );
  lines.push(
    `- Independent inventory proof: **${result.teardown.inventory}**. ${cell(result.teardown.inventoryNote)}`,
  );
  if (!result.leftovers.length) lines.push('- Leftovers: none.');
  else {
    lines.push('');
    lines.push('**The provider still holds the following, and nothing here can remove them:**');
    lines.push('');
    for (const leftover of result.leftovers)
      lines.push(`- ${leftover.kind} \`${leftover.providerId}\` — ${cell(leftover.note)}`);
  }
  lines.push('');

  for (const { question, title } of PROBE_QUESTIONS) {
    lines.push(`### Question ${question} — ${title}`);
    lines.push('');
    lines.push('| Claim | State | Evidence | Effect on the dependent cards |');
    lines.push('| --- | --- | --- | --- |');
    lines.push(...claimRows(result.claims, question));
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The date the matrix is headed with, in the findings note's own style.
 *
 * `en-GB` in UTC gives `20 August 2026`, which is how every other dated claim in that document is
 * written. A generated section that formats its date differently from the hand-written ones reads as
 * a different document.
 */
export function probeMatrixDate(now: Date): string {
  return now.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

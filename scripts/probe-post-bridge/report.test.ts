/**
 * The plan a person agrees to, the matrix that gets committed, and one test that reads the committed
 * matrix back out of `docs/post-bridge-api-surface.md`.
 *
 * That last one is the important one. The matrix is the only artefact of a probe session anybody
 * keeps, so the risk is not that the renderer is wrong — it is that somebody later edits the table by
 * hand and turns "still unverified" into a sentence that sounds like permission. The document test
 * asserts the structure the renderer produces: one row per claim, one of four states, and a
 * still-unverified row whose disposition is exactly the blocked sentence and nothing else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_STATE_LABEL,
  claimDisposition,
  initialClaims,
  PROBE_CLAIMS,
  type ProbeClaimResult,
} from './claims.ts';
import { PROBE_REQUEST_BUDGET } from './budget.ts';
import type { ProbeConfig } from './config.ts';
import type { ProbeFixture, ProbeFixtureKey } from './fixtures.ts';
import { renderPlan, renderResultMatrix, RESULT_MATRIX_HEADING, unrunResult } from './report.ts';

const FIXTURES = new Map<ProbeFixtureKey, ProbeFixture>([
  [
    'image',
    {
      key: 'image',
      name: 'probe-image.png',
      mimeType: 'image/png',
      sizeBytes: 136,
      sha256: 'abc123',
      bytes: new Uint8Array([1]),
    },
  ],
]);

const CONFIG: ProbeConfig = {
  mode: 'live',
  apiKey: 'pb_live_secret',
  baseUrl: 'https://api.example.test/v1',
  scheduledAt: '2026-08-25T14:00:00.000Z',
  probeLabel: 'hcc-probe-0820',
  accounts: [
    { platform: 'linkedin', accountId: 101 },
    { platform: 'linkedin', accountId: 102 },
  ],
};

describe('renderPlan', () => {
  const plan = renderPlan(CONFIG, FIXTURES, ['No youtube account is named.']);

  it('names every account by platform and provider id', () => {
    expect(plan).toContain('linkedin account 101');
    expect(plan).toContain('linkedin account 102');
  });

  it('lists the mutations and the promises, so the confirmation is about writes', () => {
    expect(plan).toContain('create up to five scheduled posts');
    expect(plan).toContain('DELETE every post it created');
    expect(plan).toContain('re-read the complete post inventory');
    expect(plan).toContain('will not: publish anything');
  });

  it('names the fixtures by hash and the budget by both numbers', () => {
    expect(plan).toContain('probe-image.png (image/png, 136 bytes, sha256 abc123)');
    expect(plan).toContain(`${PROBE_REQUEST_BUDGET} in total`);
  });

  it('repeats the questions this invocation cannot answer', () => {
    expect(plan).toContain('No youtube account is named.');
  });

  it('never prints the key', () => {
    expect(plan).not.toContain('pb_live_secret');
  });

  it('says plainly that plan mode contacts nothing', () => {
    expect(renderPlan({ ...CONFIG, mode: 'plan' }, FIXTURES, [])).toContain('nothing is contacted');
  });
});

describe('renderResultMatrix', () => {
  const rendered = renderResultMatrix(unrunResult(FIXTURES), { date: '20 August 2026' });

  it('is headed by its date', () => {
    expect(rendered.startsWith(`${RESULT_MATRIX_HEADING} — 20 August 2026`)).toBe(true);
  });

  it('says outright that no session has run', () => {
    expect(rendered).toContain('**No live session has been run.**');
  });

  it('gives every claim exactly one row', () => {
    for (const claim of PROBE_CLAIMS) {
      const rows = rendered.split('\n').filter((line) => line.includes(claim.claim.slice(0, 40)));
      expect(rows).toHaveLength(1);
    }
  });

  it('carries the fixture hashes, so the evidence names what would be uploaded', () => {
    expect(rendered).toContain('| `probe-image.png` | `image/png` | 136 | `abc123` |');
  });

  it('reports the teardown state even when there was nothing to tear down', () => {
    expect(rendered).toContain('Independent inventory proof: **not-verified**');
    expect(rendered).toContain('Leftovers: none.');
  });

  it('flattens a cell rather than letting evidence break the table', () => {
    const claims: ProbeClaimResult[] = initialClaims().map((claim, index) =>
      index === 0 ? { ...claim, state: 'negative', evidence: ['a | b\nc'] } : claim,
    );
    const table = renderResultMatrix(
      {
        ...unrunResult(FIXTURES),
        claims,
        calls: [{ label: 'x', method: 'GET', url: 'u', status: 200, headers: {}, teardown: false }],
      },
      { date: '20 August 2026' },
    );
    const row = table.split('\n').find((line) => line.includes('a \\| b'));
    expect(row).toBeDefined();
    // The pipe survives as an escaped one and the newline is gone, so the row is still one row.
    expect(row).toContain('a \\| b c');
    expect(row?.split(/(?<!\\)\|/)).toHaveLength(6);
  });

  it('says how much of the budget a session spent, and where it stopped', () => {
    const table = renderResultMatrix(
      {
        ...unrunResult(FIXTURES),
        budget: { used: 31, total: 50, reserve: 14 },
        calls: [{ label: 'x', method: 'GET', url: 'u', status: 200, headers: {}, teardown: false }],
        stopped: 'the provider answered 429',
      },
      { date: '20 August 2026' },
    );
    expect(table).toContain('31 of 50 allowed requests');
    expect(table).toContain('**The run stopped early:** the provider answered 429');
  });

  it('names a leftover the provider still holds', () => {
    const table = renderResultMatrix(
      {
        ...unrunResult(FIXTURES),
        leftovers: [{ kind: 'media', providerId: 'm1', note: 'not deletable' }],
      },
      { date: '20 August 2026' },
    );
    expect(table).toContain('nothing here can remove them');
    expect(table).toContain('media `m1` — not deletable');
  });
});

describe('the matrix committed to docs/post-bridge-api-surface.md', () => {
  const note = readFileSync(
    join(import.meta.dirname, '..', '..', 'docs', 'post-bridge-api-surface.md'),
    'utf8',
  );
  const section = note.slice(note.indexOf(RESULT_MATRIX_HEADING));
  const rows = section
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Claim'),
    )
    .map((line) => line.split('|').map((cell) => cell.trim()));

  it('exists, under a dated heading', () => {
    expect(note).toContain(RESULT_MATRIX_HEADING);
    expect(section.split('\n')[0]).toMatch(/^## 14\. Live probe result matrix — .+/);
  });

  it('carries one row for every claim in the registry, and no claim the registry does not have', () => {
    const claimCells = rows.map((cells) => cells[1]);
    for (const claim of PROBE_CLAIMS) {
      const matching = claimCells.filter((cell) => cell.startsWith(claim.claim.slice(0, 40)));
      expect(matching, claim.id).toHaveLength(1);
    }
  });

  it('gives every row one of the four states and nothing else', () => {
    const labels = Object.values(CLAIM_STATE_LABEL).map((label) => `**${label}**`);
    for (const cells of rows)
      // The fixture table's rows are in the same section; skip them by shape.
      if (cells.length === 6 && cells[2].startsWith('**')) expect(labels).toContain(cells[2]);
  });

  it('gives a still-unverified row the blocked disposition and nothing that reads as permission', () => {
    for (const claim of PROBE_CLAIMS) {
      const cells = rows.find((candidate) => candidate[1]?.startsWith(claim.claim.slice(0, 40)));
      if (cells?.[2] !== `**${CLAIM_STATE_LABEL['still-unverified']}**`) continue;
      expect(cells[4]).toBe(
        claimDisposition({ ...claim, state: 'still-unverified', evidence: [] }).replace(
          /\|/g,
          '\\|',
        ),
      );
    }
  });

  it('states the four states and that an unverified claim changes nothing', () => {
    expect(section).toContain('Four states, and no fifth');
    expect(section).toContain('leaves its dependent cards blocked');
  });
});

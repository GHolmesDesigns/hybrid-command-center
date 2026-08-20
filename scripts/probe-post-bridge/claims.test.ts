import { describe, expect, it } from 'vitest';
import {
  ClaimLedger,
  claimDisposition,
  initialClaims,
  PROBE_CLAIMS,
  PROBE_QUESTIONS,
} from './claims.ts';

describe('the claim registry', () => {
  it('gives every claim a unique id', () => {
    const ids = PROBE_CLAIMS.map((claim) => claim.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('answers each of the card’s seven questions at least once', () => {
    for (const { question } of PROBE_QUESTIONS)
      expect(PROBE_CLAIMS.some((claim) => claim.question === question)).toBe(true);
    expect(PROBE_CLAIMS.every((claim) => claim.question >= 1 && claim.question <= 7)).toBe(true);
  });

  it('names a dependent card and both dispositions for every claim', () => {
    for (const claim of PROBE_CLAIMS) {
      expect(claim.dependents.length).toBeGreaterThan(0);
      expect(claim.claim.length).toBeGreaterThan(20);
      expect(claim.whenVerified.length).toBeGreaterThan(20);
      expect(claim.whenNegative.length).toBeGreaterThan(20);
    }
  });

  it('covers every card the plan says C73 blocks', () => {
    const dependents = new Set(PROBE_CLAIMS.flatMap((claim) => claim.dependents));
    for (const card of ['C75', 'C76', 'C77', 'C78', 'C79', 'C80', 'C81'])
      expect(dependents.has(card)).toBe(true);
  });

  it('starts every claim unverified, whatever else happens afterwards', () => {
    expect(initialClaims().every((claim) => claim.state === 'still-unverified')).toBe(true);
    expect(initialClaims()).toHaveLength(PROBE_CLAIMS.length);
  });
});

describe('claimDisposition', () => {
  const claim = initialClaims()[0];

  it('has one sentence for an unverified claim, and it is a blocked one', () => {
    const said = claimDisposition(claim);
    expect(said).toContain(claim.dependents.join(', '));
    expect(said).toContain('stays blocked');
    expect(said).toContain('fail-closed value is unchanged');
  });

  it('says what was decided for a verified or negative claim', () => {
    expect(claimDisposition({ ...claim, state: 'verified' })).toBe(claim.whenVerified);
    expect(claimDisposition({ ...claim, state: 'negative' })).toBe(claim.whenNegative);
  });

  it('marks a policy constraint as a refusal rather than a warning', () => {
    const said = claimDisposition({ ...claim, state: 'verified-with-policy-constraint' });
    expect(said).toContain(claim.whenVerified);
    expect(said).toContain('preflight refusal, not a warning');
  });
});

describe('ClaimLedger', () => {
  it('refuses an id the review never saw', () => {
    expect(() => new ClaimLedger().record('invented-claim', 'verified', ['x'])).toThrow(
      /No such probe claim/,
    );
  });

  it('refuses to record a claim twice, because two steps disagreeing is a bug', () => {
    const ledger = new ClaimLedger();
    ledger.record('media-limits', 'verified', ['first']);
    expect(() => ledger.record('media-limits', 'negative', ['second'])).toThrow(
      /already been recorded/,
    );
  });

  it('refuses a state with no evidence behind it', () => {
    expect(() => new ClaimLedger().record('media-limits', 'verified', [])).toThrow(/evidence/);
  });

  it('lets a skipped claim carry a reason while staying unverified', () => {
    const ledger = new ClaimLedger();
    ledger.explainUnverified('media-limits', 'No account on that platform.');
    const claim = ledger.results().find((candidate) => candidate.id === 'media-limits');
    expect(claim?.state).toBe('still-unverified');
    expect(claim?.evidence).toEqual(['No account on that platform.']);
  });

  it('never lets a reason overwrite something that was actually observed', () => {
    const ledger = new ClaimLedger();
    ledger.record('media-limits', 'verified', ['observed']);
    ledger.explainUnverified('media-limits', 'not reached');
    const claim = ledger.results().find((candidate) => candidate.id === 'media-limits');
    expect(claim?.state).toBe('verified');
    expect(claim?.evidence).toEqual(['observed']);
  });

  it('refuses an unknown id when explaining, too', () => {
    expect(() => new ClaimLedger().explainUnverified('invented', 'x')).toThrow(
      /No such probe claim/,
    );
  });

  it('returns results in registry order, so the matrix reads in the card’s order', () => {
    expect(new ClaimLedger().results().map((claim) => claim.id)).toEqual(
      PROBE_CLAIMS.map((claim) => claim.id),
    );
  });
});

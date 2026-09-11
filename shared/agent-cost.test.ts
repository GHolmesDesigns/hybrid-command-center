import { describe, expect, it } from 'vitest';
import {
  AGENT_COST_ATTRIBUTION_CONFIDENCE_LABEL,
  AGENT_COST_ATTRIBUTION_CONFIDENCES,
  agentCostAttributionPhrase,
  agentCostAttributionStorable,
  parseProviderAgentCostList,
  parseProviderAgentCostRecord,
} from './agent-cost.ts';

describe('agent cost contract', () => {
  const sample = {
    provider: 'cursor',
    model: 'gpt-4.1',
    quantity: 128_450,
    unit: 'tokens' as const,
    currency: 'USD',
    windowStart: '2026-09-01T00:00:00.000Z',
    windowEnd: '2026-09-11T23:59:59.999Z',
    attributionConfidence: 'exact',
    agentLabel: 'queue-agent',
  };

  it('stores provider numbers verbatim after validation', () => {
    const outcome = parseProviderAgentCostRecord(sample);
    expect(outcome.record).toEqual(sample);
    expect(outcome.warning).toBeUndefined();
  });

  it('refuses rows that fail validation', () => {
    const outcome = parseProviderAgentCostRecord({ ...sample, quantity: -1 });
    expect(outcome.record).toBeUndefined();
    expect(outcome.warning).toMatch(/Refused/);
  });

  it('drops attribution values that are not short lower-case tokens', () => {
    const outcome = parseProviderAgentCostRecord({
      ...sample,
      attributionConfidence: 'Exact',
    });
    expect(outcome.record?.attributionConfidence).toBeUndefined();
    expect(outcome.warning).toMatch(/attribution confidence/);
  });

  it('labels known attribution values and keeps unknown ones readable', () => {
    for (const value of AGENT_COST_ATTRIBUTION_CONFIDENCES) {
      expect(agentCostAttributionPhrase(value).text).toBe(
        `Provider attribution: ${AGENT_COST_ATTRIBUTION_CONFIDENCE_LABEL[value]}`,
      );
    }
    const unknown = agentCostAttributionPhrase('probable_match');
    expect(unknown.known).toBe(false);
    expect(unknown.text).toContain('probable_match');
  });

  it('accepts only storable attribution tokens', () => {
    expect(agentCostAttributionStorable('exact')).toBe(true);
    expect(agentCostAttributionStorable('Exact')).toBe(false);
    expect(agentCostAttributionStorable('x'.repeat(41))).toBe(false);
  });

  it('parses a provider list and carries parser warnings beside records', () => {
    const parsed = parseProviderAgentCostList({
      records: [sample, { ...sample, quantity: -5 }],
      warnings: ['Provider noted a delay.'],
    });
    expect(parsed.records).toHaveLength(1);
    expect(parsed.warnings.some((warning) => warning.includes('Refused'))).toBe(true);
    expect(parsed.warnings).toContain('Provider noted a delay.');
  });

  it('refuses list envelopes that are not objects with records', () => {
    expect(() => parseProviderAgentCostList(null)).toThrow(/did not pass validation/);
  });

  it('names the validation field when a row is refused', () => {
    const outcome = parseProviderAgentCostRecord(undefined);
    expect(outcome.warning).toMatch(/Refused a provider usage row/);
  });
});

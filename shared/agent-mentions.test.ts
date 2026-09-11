import { describe, expect, it } from 'vitest';
import { knownAgentMentionLabels, parseAgentMentions } from './agent-mentions.ts';

const directory = ['cursor', 'review.bot', 'e2e-agent'];

describe('parseAgentMentions', () => {
  it('recognizes token-bound known labels and ignores unknown, email, and mid-word strings', () => {
    expect(parseAgentMentions('Please @cursor and @review.bot review this.', directory)).toEqual([
      expect.objectContaining({ label: 'cursor', known: true }),
      expect.objectContaining({ label: 'review.bot', known: true }),
    ]);
    expect(parseAgentMentions('Email me at user@example.com today.', directory)).toEqual([]);
    expect(parseAgentMentions('Midword@cursor should not match.', directory)).toEqual([]);
    expect(parseAgentMentions('Try @unknown-label please.', directory)).toEqual([
      expect.objectContaining({ label: 'unknown-label', known: false }),
    ]);
  });

  it('deduplicates repeated mentions of the same label', () => {
    expect(knownAgentMentionLabels('@cursor and @cursor again', directory)).toEqual(['cursor']);
  });

  it('offers two distinct known mentions separately', () => {
    expect(knownAgentMentionLabels('@cursor please loop in @e2e-agent', directory)).toEqual([
      'cursor',
      'e2e-agent',
    ]);
  });
});

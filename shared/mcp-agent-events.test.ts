import { describe, expect, it } from 'vitest';
import { normalizeOptionalAgentLabel } from './mcp-agent-events.ts';

describe('normalizeOptionalAgentLabel', () => {
  it('treats blank as null and accepts a valid label', () => {
    expect(normalizeOptionalAgentLabel(undefined)).toBeNull();
    expect(normalizeOptionalAgentLabel('')).toBeNull();
    expect(normalizeOptionalAgentLabel('  ')).toBeNull();
    expect(normalizeOptionalAgentLabel('cursor')).toBe('cursor');
  });

  it('rejects an invalid label charset', () => {
    expect(() => normalizeOptionalAgentLabel('bad label!')).toThrow();
  });

  it('rejects the reserved command-ai assistant label', () => {
    for (const label of ['command-ai', ' Command-AI ', 'COMMAND-AI']) {
      expect(() => normalizeOptionalAgentLabel(label)).toThrow(/reserved/i);
    }
  });
});

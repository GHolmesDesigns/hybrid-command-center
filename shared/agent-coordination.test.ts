import { describe, expect, it } from 'vitest';
import {
  AGENT_COORDINATION_LIMITS,
  agentHandoffCancelReasonSchema,
  agentHandoffMessageSchema,
  agentHandoffNoteBodySchema,
  agentLabelSchema,
  containsCredentialShape,
} from './agent-coordination.ts';

describe('agent label schema', () => {
  it('accepts portable labels and refuses empty or illegal charset', () => {
    expect(agentLabelSchema.parse('cursor')).toBe('cursor');
    expect(agentLabelSchema.parse(' Claude-Code ')).toBe('Claude-Code');
    expect(agentLabelSchema.parse('a')).toBe('a');
    expect(() => agentLabelSchema.parse('')).toThrow();
    expect(() => agentLabelSchema.parse('-leading')).toThrow();
    expect(() => agentLabelSchema.parse('trailing-')).toThrow();
    expect(() => agentLabelSchema.parse('has space')).toThrow();
    expect(() =>
      agentLabelSchema.parse('a'.repeat(AGENT_COORDINATION_LIMITS.agentLabel + 1)),
    ).toThrow();
  });
});

describe('handoff free-text bounds', () => {
  it('enforces length and refuses credential-shaped bodies', () => {
    expect(agentHandoffMessageSchema.parse(' Please review this caption. ')).toBe(
      'Please review this caption.',
    );
    expect(() => agentHandoffMessageSchema.parse('')).toThrow();
    expect(() =>
      agentHandoffMessageSchema.parse('x'.repeat(AGENT_COORDINATION_LIMITS.message + 1)),
    ).toThrow();
    expect(() => agentHandoffMessageSchema.parse('api_key=sk-live-secret')).toThrow(/credentials/i);
    expect(() => agentHandoffNoteBodySchema.parse('Bearer ya29.a0AfH6')).toThrow(/credentials/i);
    expect(() => agentHandoffCancelReasonSchema.parse('password: hunter2')).toThrow(/credentials/i);
    expect(containsCredentialShape('https://example.com/path?ref=abc')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { redactAssistantContext } from './redact.ts';

describe('redactAssistantContext', () => {
  it('scrubs credentials and client contact fields', () => {
    const input = {
      email: 'client@example.com',
      phone: '555-0100',
      notes: 'Private notes',
      token: 'Bearer ya29.secret-value-here',
      path: 'C:\\Users\\me\\command-center.db',
      ssm: '/hcc/production/SESSION_SECRET',
      log: { entities: [{ id: '1' }], summary: 'sync done' },
    };
    const redacted = redactAssistantContext(input) as Record<string, unknown>;
    expect(redacted.email).toBe('[redacted]');
    expect(redacted.phone).toBe('[redacted]');
    expect(redacted.notes).toBe('[redacted]');
    expect(String(redacted.token)).toContain('[redacted]');
    expect(String(redacted.path)).toContain('[path redacted]');
    expect(String(redacted.ssm)).toBe('[ssm redacted]');
    expect((redacted.log as Record<string, unknown>).entities).toBe(
      '[integration payload redacted]',
    );
  });

  it('redacts tool-result strings', () => {
    expect(redactAssistantContext('password: hunter2')).toContain('[redacted]');
  });

  it('walks arrays and nested client records', () => {
    const redacted = redactAssistantContext([
      { email: 'a@example.com', nested: { phone: '555' } },
      'ASSISTANT_KEY_ENCRYPTION_KEY=secret',
    ]) as unknown[];
    expect((redacted[0] as Record<string, unknown>).email).toBe('[redacted]');
    expect(((redacted[0] as Record<string, unknown>).nested as Record<string, unknown>).phone).toBe(
      '[redacted]',
    );
    expect(String(redacted[1])).toContain('[encryption-key redacted]');
  });
});

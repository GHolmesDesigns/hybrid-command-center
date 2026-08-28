import { describe, expect, it } from 'vitest';
import {
  mcpCoordinationAgentLabelRequired,
  mcpCoordinationErrorFromMessage,
  mcpCoordinationRateLimitExceeded,
  MCP_COORDINATION_ERROR_CODES,
} from './mcp-coordination-errors.ts';

describe('mcpCoordinationErrorDetail', () => {
  it('keeps error codes in a closed union', () => {
    expect(MCP_COORDINATION_ERROR_CODES).toContain('COORDINATION_RATE_LIMIT_EXCEEDED');
    expect(MCP_COORDINATION_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('marks rate-limit refusals retryable with retryAfterMs', () => {
    expect(mcpCoordinationRateLimitExceeded(750)).toMatchObject({
      code: 'COORDINATION_RATE_LIMIT_EXCEEDED',
      retryable: true,
      retryAfterMs: 750,
    });
  });

  it('marks missing agent label refusals non-retryable', () => {
    expect(mcpCoordinationAgentLabelRequired()).toMatchObject({
      code: 'COORDINATION_AGENT_LABEL_REQUIRED',
      retryable: false,
    });
  });

  it('maps authorization refusals without changing prose classification', () => {
    expect(
      mcpCoordinationErrorFromMessage('Only claude may claim this directed handoff.', 409),
    ).toMatchObject({
      code: 'COORDINATION_UNAUTHORIZED',
      retryable: false,
    });
    expect(
      mcpCoordinationErrorFromMessage(
        'Only a CLAIMED handoff can be completed (state is OPEN).',
        409,
        'OPEN',
      ),
    ).toMatchObject({
      code: 'COORDINATION_INVALID_STATE',
      retryable: false,
      currentState: 'OPEN',
    });
  });
});

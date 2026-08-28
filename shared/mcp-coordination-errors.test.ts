import { describe, expect, it } from 'vitest';
import {
  mcpCoordinationAgentLabelRequired,
  mcpCoordinationErrorFromMessage,
  mcpCoordinationInvalidArguments,
  mcpCoordinationNotFound,
  mcpCoordinationRateLimitExceeded,
  mcpCoordinationSessionLabelMismatch,
  mcpCoordinationToolFailed,
  mcpCoordinationUnknownTool,
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

  it('maps HTTP status codes before message heuristics', () => {
    expect(mcpCoordinationErrorFromMessage('missing', 404)).toEqual(mcpCoordinationNotFound());
    expect(mcpCoordinationErrorFromMessage('bad args', 400)).toEqual(
      mcpCoordinationInvalidArguments(),
    );
  });

  it('maps completion and cancellation failures without a requiredAction', () => {
    expect(
      mcpCoordinationErrorFromMessage('Handoff could not be completed.', 409, 'CLAIMED'),
    ).toMatchObject({
      code: 'COORDINATION_INVALID_STATE',
      retryable: false,
      currentState: 'CLAIMED',
    });
    expect(mcpCoordinationErrorFromMessage('Handoff could not be cancelled.', 409)).toMatchObject({
      code: 'COORDINATION_INVALID_STATE',
      retryable: false,
    });
  });

  it('falls back to invalid state for unmatched 409 prose', () => {
    expect(mcpCoordinationErrorFromMessage('Unexpected conflict.', 409, 'DONE')).toMatchObject({
      code: 'COORDINATION_INVALID_STATE',
      retryable: false,
      currentState: 'DONE',
    });
  });

  it('exposes static refusal helpers for session and tool errors', () => {
    expect(mcpCoordinationSessionLabelMismatch()).toMatchObject({
      code: 'COORDINATION_SESSION_LABEL_MISMATCH',
      retryable: false,
    });
    expect(mcpCoordinationUnknownTool()).toMatchObject({
      code: 'COORDINATION_UNKNOWN_TOOL',
      retryable: false,
    });
    expect(mcpCoordinationToolFailed()).toMatchObject({
      code: 'COORDINATION_TOOL_FAILED',
      retryable: false,
    });
  });
});

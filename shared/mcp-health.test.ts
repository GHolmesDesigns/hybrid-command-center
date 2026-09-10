import { describe, expect, it } from 'vitest';
import {
  deriveMcpHealthPanelState,
  inferErrorCodeFromSummary,
  isRateLimitSummary,
  isStaleClaimedHandoff,
  outcomeIsFailure,
} from './mcp-health.ts';
import type { McpAgentCredentialSummary } from './mcp-agent-registry.ts';
import type { AgentHandoff } from './agent-coordination.ts';

const credential = (label: string, lastUsedAt: string | null): McpAgentCredentialSummary => ({
  id: `cred-${label}`,
  agentId: `agent-${label}`,
  label,
  scopes: ['coordination:read'],
  issuedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
  lastUsedAt,
  lastOrigin: null,
  revokedAt: null,
});

describe('inferErrorCodeFromSummary', () => {
  it('maps audit prose to structured codes', () => {
    expect(inferErrorCodeFromSummary('Credential lacks coordination:write.')).toBe(
      'COORDINATION_SCOPE_REQUIRED',
    );
    expect(inferErrorCodeFromSummary('Credential lacks workspace:read.')).toBe(
      'WORKSPACE_SCOPE_REQUIRED',
    );
    expect(inferErrorCodeFromSummary('Coordination write rate limit exceeded.')).toBe(
      'COORDINATION_RATE_LIMIT_EXCEEDED',
    );
    expect(inferErrorCodeFromSummary('x-agent-label does not match')).toBe(
      'COORDINATION_CREDENTIAL_LABEL_MISMATCH',
    );
    expect(inferErrorCodeFromSummary('Session label refused for poster.')).toBe(
      'COORDINATION_SESSION_LABEL_MISMATCH',
    );
    expect(inferErrorCodeFromSummary('Missing agent_label on write.')).toBe(
      'COORDINATION_AGENT_LABEL_REQUIRED',
    );
    expect(inferErrorCodeFromSummary('Invalid state for complete.')).toBe(
      'COORDINATION_INVALID_STATE',
    );
    expect(inferErrorCodeFromSummary('Handoff not found.')).toBe('COORDINATION_NOT_FOUND');
    expect(inferErrorCodeFromSummary('Unknown tool: foo.')).toBe('COORDINATION_UNKNOWN_TOOL');
    expect(inferErrorCodeFromSummary('Unauthorized claim.')).toBe('COORDINATION_UNAUTHORIZED');
    expect(inferErrorCodeFromSummary('Invalid arguments for note.')).toBe(
      'COORDINATION_INVALID_ARGUMENTS',
    );
    expect(inferErrorCodeFromSummary('Something else entirely.')).toBeNull();
  });
});

describe('isRateLimitSummary', () => {
  it('detects rate-limit rows', () => {
    expect(isRateLimitSummary('Coordination write rate limit exceeded.')).toBe(true);
    expect(isRateLimitSummary('coordination_post_handoff succeeded.')).toBe(false);
  });
});

describe('deriveMcpHealthPanelState', () => {
  it('distinguishes never connected from all failed', () => {
    expect(
      deriveMcpHealthPanelState({
        registry: [],
        agents: [],
        auditUnreadable: false,
      }).state,
    ).toBe('never_connected');
    expect(
      deriveMcpHealthPanelState({
        registry: [credential('cursor', '2026-08-28T12:00:00.000Z')],
        agents: [
          {
            label: 'cursor',
            lastUsedAt: '2026-08-28T12:00:00.000Z',
            lastOrigin: null,
            lastSuccessAt: null,
            lastFailureAt: '2026-08-28T12:00:00.000Z',
            requestCount: 2,
            refusalCount: 2,
            failureCount: 0,
            rateLimitCount: 0,
            isStale: false,
          },
        ],
        auditUnreadable: false,
      }).state,
    ).toBe('all_failed');
  });

  it('reports unavailable, mixed, and healthy states', () => {
    expect(
      deriveMcpHealthPanelState({
        registry: [],
        agents: [],
        auditUnreadable: true,
      }),
    ).toEqual({
      state: 'unavailable',
      reason: 'The MCP audit table could not be read.',
    });
    expect(
      deriveMcpHealthPanelState({
        registry: [],
        agents: [
          {
            label: 'cursor',
            lastUsedAt: null,
            lastOrigin: null,
            lastSuccessAt: '2026-08-28T12:00:00.000Z',
            lastFailureAt: null,
            requestCount: 1,
            refusalCount: 0,
            failureCount: 0,
            rateLimitCount: 0,
            isStale: false,
          },
        ],
        auditUnreadable: false,
      }).state,
    ).toBe('healthy');
    expect(
      deriveMcpHealthPanelState({
        registry: [],
        agents: [
          {
            label: 'cursor',
            lastUsedAt: null,
            lastOrigin: null,
            lastSuccessAt: '2026-08-28T11:00:00.000Z',
            lastFailureAt: '2026-08-28T12:00:00.000Z',
            requestCount: 2,
            refusalCount: 1,
            failureCount: 0,
            rateLimitCount: 0,
            isStale: false,
          },
        ],
        auditUnreadable: false,
      }).state,
    ).toBe('mixed');
  });
});

describe('outcomeIsFailure', () => {
  it('treats refused and failure outcomes as failures', () => {
    expect(outcomeIsFailure('REFUSED')).toBe(true);
    expect(outcomeIsFailure('FAILURE')).toBe(true);
    expect(outcomeIsFailure('SUCCESS')).toBe(false);
  });
});

describe('isStaleClaimedHandoff', () => {
  const handoff = (claimedAt: string): AgentHandoff => ({
    id: 'h1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: claimedAt,
    fromAgentLabel: 'cursor',
    fromAgentProvenance: 'UNKNOWN',
    toAgentLabel: null,
    subjectType: 'freeform',
    subjectId: null,
    message: 'Work',
    state: 'CLAIMED',
    claimedBy: 'codex',
    claimedByProvenance: 'UNKNOWN',
    claimedAt,
    completedAt: null,
    completedByProvenance: null,
    cancelledAt: null,
    cancelReason: null,
    clientRequestId: null,
  });

  it('flags long-running CLAIMED handoffs using the §5.4 OPEN TTL', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    expect(isStaleClaimedHandoff(handoff('2026-07-01T00:00:00.000Z'), now)).toBe(true);
    expect(isStaleClaimedHandoff(handoff('2026-08-20T00:00:00.000Z'), now)).toBe(false);
  });

  it('ignores invalid claim timestamps', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    expect(isStaleClaimedHandoff(handoff('not-a-date'), now)).toBe(false);
  });
});

describe('deriveMcpHealthPanelState healthy path', () => {
  it('reports healthy when every active agent only succeeds', () => {
    expect(
      deriveMcpHealthPanelState({
        registry: [],
        agents: [
          {
            label: 'cursor',
            lastUsedAt: null,
            lastOrigin: null,
            lastSuccessAt: '2026-08-28T12:00:00.000Z',
            lastFailureAt: null,
            requestCount: 3,
            refusalCount: 0,
            failureCount: 0,
            rateLimitCount: 0,
            isStale: false,
          },
        ],
        auditUnreadable: false,
      }).state,
    ).toBe('healthy');
  });
});

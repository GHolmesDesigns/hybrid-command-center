/**
 * Agent handoff lifecycle rules (C110).
 *
 * Framework-free on purpose: claim, complete, cancel, and note authorization live here so the
 * service, MCP tools (C111), and HTTP routes (operator cancel) cannot diverge. Nothing here
 * touches a database or a network — callers pass a handoff snapshot and get a decision.
 *
 * Completing a handoff is a state flip only. There is no path from these rules to publish, Drive,
 * or import.
 */
import type { AgentHandoff } from '../../shared/agent-coordination.ts';

export type CoordinationDecision =
  { kind: 'apply' } | { kind: 'idempotent' } | { kind: 'refused'; reason: string };

export class AgentCoordinationError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentCoordinationError';
    this.status = status;
  }
}

/** Who may claim: directed label match, or any label on an open pool. Already claimed by self is idempotent. */
export function decideClaim(handoff: AgentHandoff, agentLabel: string): CoordinationDecision {
  if (handoff.state === 'CLAIMED' && handoff.claimedBy === agentLabel)
    return { kind: 'idempotent' };
  if (handoff.state !== 'OPEN') {
    return {
      kind: 'refused',
      reason: `Only an OPEN handoff can be claimed (state is ${handoff.state}).`,
    };
  }
  if (handoff.toAgentLabel !== null && handoff.toAgentLabel !== agentLabel) {
    return {
      kind: 'refused',
      reason: `Only ${handoff.toAgentLabel} may claim this directed handoff.`,
    };
  }
  return { kind: 'apply' };
}

/** MCP complete: only the claimer, and only from CLAIMED. Already completed is idempotent for that claimer. */
export function decideComplete(handoff: AgentHandoff, agentLabel: string): CoordinationDecision {
  if (handoff.state === 'COMPLETED' && handoff.claimedBy === agentLabel)
    return { kind: 'idempotent' };
  if (handoff.state !== 'CLAIMED') {
    return {
      kind: 'refused',
      reason: `Only a CLAIMED handoff can be completed (state is ${handoff.state}).`,
    };
  }
  if (handoff.claimedBy !== agentLabel) {
    return {
      kind: 'refused',
      reason: 'Only the agent that claimed this handoff may complete it.',
    };
  }
  return { kind: 'apply' };
}

/**
 * Agent cancel: poster or current claimer, and only from OPEN or CLAIMED.
 * Already cancelled is idempotent for an authorized agent.
 */
export function decideAgentCancel(handoff: AgentHandoff, agentLabel: string): CoordinationDecision {
  const authorized = handoff.fromAgentLabel === agentLabel || handoff.claimedBy === agentLabel;
  if (handoff.state === 'CANCELLED' && authorized) return { kind: 'idempotent' };
  if (handoff.state !== 'OPEN' && handoff.state !== 'CLAIMED') {
    return {
      kind: 'refused',
      reason: `Only an OPEN or CLAIMED handoff can be cancelled by an agent (state is ${handoff.state}).`,
    };
  }
  if (!authorized) {
    return {
      kind: 'refused',
      reason: 'Only the posting agent or the current claimer may cancel this handoff.',
    };
  }
  return { kind: 'apply' };
}

/**
 * Operator cancel over HTTP: any state except COMPLETED.
 * Already cancelled is idempotent.
 */
export function decideOperatorCancel(handoff: AgentHandoff): CoordinationDecision {
  if (handoff.state === 'CANCELLED') return { kind: 'idempotent' };
  if (handoff.state === 'COMPLETED') {
    return {
      kind: 'refused',
      reason: 'A completed handoff cannot be cancelled.',
    };
  }
  return { kind: 'apply' };
}

/** Notes are refused on CANCELLED; OPEN, CLAIMED, and COMPLETED accept append-only notes. */
export function decideAddNote(handoff: AgentHandoff): CoordinationDecision {
  if (handoff.state === 'CANCELLED') {
    return {
      kind: 'refused',
      reason: 'Notes cannot be added to a cancelled handoff.',
    };
  }
  return { kind: 'apply' };
}

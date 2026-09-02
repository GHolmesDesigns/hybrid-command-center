import { describe, expect, it } from 'vitest';
import type { AgentHandoff } from '../../shared/agent-coordination.ts';
import {
  decideAddNote,
  decideAgentCancel,
  decideClaim,
  decideComplete,
  decideOperatorCancel,
} from './agent-coordination.ts';

const base = (overrides: Partial<AgentHandoff> = {}): AgentHandoff => ({
  id: 'h1',
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
  fromAgentLabel: 'cursor',
  fromAgentProvenance: 'UNKNOWN',
  toAgentLabel: null,
  subjectType: 'freeform',
  subjectId: null,
  message: 'Review this caption',
  state: 'OPEN',
  claimedBy: null,
  claimedByProvenance: null,
  claimedAt: null,
  completedAt: null,
  completedByProvenance: null,
  cancelledAt: null,
  cancelReason: null,
  clientRequestId: null,
  ...overrides,
});

describe('decideClaim', () => {
  it('allows any label on an open pool and only the target on a directed handoff', () => {
    expect(decideClaim(base(), 'claude')).toEqual({ kind: 'apply' });
    expect(decideClaim(base({ toAgentLabel: 'claude' }), 'claude')).toEqual({ kind: 'apply' });
    expect(decideClaim(base({ toAgentLabel: 'claude' }), 'cursor').kind).toBe('refused');
  });

  it('is idempotent when already claimed by the same label', () => {
    expect(
      decideClaim(
        base({ state: 'CLAIMED', claimedBy: 'claude', claimedAt: '2026-08-26T12:01:00.000Z' }),
        'claude',
      ),
    ).toEqual({ kind: 'idempotent' });
  });

  it('refuses a second claimer once claimed', () => {
    expect(
      decideClaim(
        base({ state: 'CLAIMED', claimedBy: 'claude', claimedAt: '2026-08-26T12:01:00.000Z' }),
        'other',
      ).kind,
    ).toBe('refused');
  });
});

describe('decideComplete', () => {
  it('allows only the claimer from CLAIMED', () => {
    const claimed = base({
      state: 'CLAIMED',
      claimedBy: 'claude',
      claimedAt: '2026-08-26T12:01:00.000Z',
    });
    expect(decideComplete(claimed, 'claude')).toEqual({ kind: 'apply' });
    expect(decideComplete(claimed, 'cursor').kind).toBe('refused');
    expect(decideComplete(base(), 'claude').kind).toBe('refused');
  });
});

describe('decideAgentCancel and decideOperatorCancel', () => {
  it('lets the poster or claimer cancel OPEN or CLAIMED', () => {
    expect(decideAgentCancel(base(), 'cursor')).toEqual({ kind: 'apply' });
    expect(
      decideAgentCancel(
        base({ state: 'CLAIMED', claimedBy: 'claude', claimedAt: '2026-08-26T12:01:00.000Z' }),
        'claude',
      ),
    ).toEqual({ kind: 'apply' });
    expect(decideAgentCancel(base(), 'stranger').kind).toBe('refused');
  });

  it('lets the operator cancel any non-COMPLETED state', () => {
    expect(decideOperatorCancel(base())).toEqual({ kind: 'apply' });
    expect(
      decideOperatorCancel(
        base({ state: 'CLAIMED', claimedBy: 'claude', claimedAt: '2026-08-26T12:01:00.000Z' }),
      ),
    ).toEqual({ kind: 'apply' });
    expect(
      decideOperatorCancel(
        base({
          state: 'COMPLETED',
          claimedBy: 'claude',
          claimedAt: '2026-08-26T12:01:00.000Z',
          completedAt: '2026-08-26T12:02:00.000Z',
        }),
      ).kind,
    ).toBe('refused');
    expect(
      decideOperatorCancel(
        base({
          state: 'CANCELLED',
          cancelledAt: '2026-08-26T12:03:00.000Z',
          cancelReason: 'stale',
        }),
      ),
    ).toEqual({ kind: 'idempotent' });
  });
});

describe('decideAddNote', () => {
  it('refuses notes on CANCELLED and allows them otherwise', () => {
    expect(decideAddNote(base())).toEqual({ kind: 'apply' });
    expect(
      decideAddNote(
        base({
          state: 'COMPLETED',
          claimedBy: 'claude',
          claimedAt: '2026-08-26T12:01:00.000Z',
          completedAt: '2026-08-26T12:02:00.000Z',
        }),
      ),
    ).toEqual({ kind: 'apply' });
    expect(
      decideAddNote(
        base({
          state: 'CANCELLED',
          cancelledAt: '2026-08-26T12:03:00.000Z',
          cancelReason: 'stale',
        }),
      ).kind,
    ).toBe('refused');
  });
});

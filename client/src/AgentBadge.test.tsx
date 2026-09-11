import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentBadge } from './components/AgentBadge';

describe('AgentBadge', () => {
  it('renders the operator badge', () => {
    render(<AgentBadge operator />);
    expect(screen.getByText('You')).toBeVisible();
    expect(screen.getByText('Operator')).toBeVisible();
  });

  it('renders a verified agent with live presence and provenance', () => {
    render(
      <AgentBadge
        profile={{ label: 'reviewer', displayName: 'Queue Reviewer', trustLevel: 'VERIFIED' }}
        presence={{ state: 'AVAILABLE', lastActivityAt: new Date().toISOString() }}
        provenance="VERIFIED"
      />,
    );
    expect(screen.getByText('Queue Reviewer')).toBeVisible();
    expect(screen.getByText(/@reviewer/)).toBeVisible();
    expect(screen.getByText(/Available/)).toBeVisible();
    expect(screen.getByText(/Verified agent/)).toBeVisible();
    expect(screen.getByText(/Identity verified by scoped credential/)).toBeVisible();
  });

  it('renders unknown presence when activity is stale', () => {
    render(
      <AgentBadge
        profile={{ label: 'worker', displayName: 'Worker', trustLevel: 'UNVERIFIED' }}
        presence={{ state: 'BUSY', lastActivityAt: '2020-01-01T00:00:00.000Z' }}
        provenance="ASSERTED"
      />,
    );
    expect(screen.getByText(/Presence unknown/)).toBeVisible();
    expect(screen.getByText(/Unverified agent/)).toBeVisible();
  });

  it('hides meta copy in compact mode', () => {
    render(
      <AgentBadge
        compact
        profile={{ label: 'worker', displayName: 'Worker', trustLevel: 'UNVERIFIED' }}
      />,
    );
    expect(screen.getByText('Worker')).toBeVisible();
    expect(screen.queryByText(/@worker/)).toBeNull();
  });
});

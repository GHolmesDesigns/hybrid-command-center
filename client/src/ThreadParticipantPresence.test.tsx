import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadParticipantPresence } from './components/ThreadParticipantPresence';

describe('ThreadParticipantPresence', () => {
  it('shows online and offline states for agent participants', () => {
    render(
      <ThreadParticipantPresence
        participants={['operator', 'reviewer', 'planner']}
        agentProfiles={{
          reviewer: { label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' },
          planner: { label: 'planner', displayName: 'Planner', trustLevel: 'UNVERIFIED' },
        }}
        presenceByLabel={{
          reviewer: { state: 'AVAILABLE', lastActivityAt: new Date().toISOString() },
          planner: { state: 'OFFLINE', lastActivityAt: new Date().toISOString() },
        }}
      />,
    );
    expect(screen.getByLabelText('Thread participants')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('treats stale presence as offline', () => {
    render(
      <ThreadParticipantPresence
        participants={['reviewer']}
        agentProfiles={{
          reviewer: { label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' },
        }}
        presenceByLabel={{
          reviewer: { state: 'AVAILABLE', lastActivityAt: '2020-01-01T00:00:00.000Z' },
        }}
      />,
    );
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('renders nothing when only the operator participates', () => {
    const { container } = render(
      <ThreadParticipantPresence
        participants={['operator']}
        agentProfiles={{}}
        presenceByLabel={{}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

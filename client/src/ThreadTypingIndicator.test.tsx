import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadTypingIndicator } from './components/ThreadTypingIndicator';

describe('ThreadTypingIndicator', () => {
  it('shows a single-agent typing line', () => {
    render(
      <ThreadTypingIndicator
        typingLabels={['reviewer']}
        agentProfiles={{
          reviewer: { label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' },
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Reviewer is typing…');
  });

  it('joins two typing agents with and', () => {
    render(
      <ThreadTypingIndicator
        typingLabels={['reviewer', 'planner']}
        agentProfiles={{
          reviewer: { label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' },
          planner: { label: 'planner', displayName: 'Planner', trustLevel: 'UNVERIFIED' },
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Reviewer and Planner are typing…');
  });

  it('renders nothing when no agents are typing', () => {
    const { container } = render(<ThreadTypingIndicator typingLabels={[]} agentProfiles={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

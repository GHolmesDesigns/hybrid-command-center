import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConversationTurn } from './components/ConversationTurn';

describe('ConversationTurn', () => {
  it('renders an operator turn without a thought block', () => {
    render(
      <MemoryRouter>
        <ConversationTurn
          message={{
            id: 'm1',
            senderLabel: 'operator',
            sentAt: '2026-09-11T12:00:00.000Z',
            body: 'Hello team',
          }}
          agentProfiles={{}}
          presenceByLabel={{}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Hello team')).toBeVisible();
    expect(screen.getByText('You')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Thought/i })).toBeNull();
  });

  it('expands a stored thought summary for agent messages', () => {
    render(
      <MemoryRouter>
        <ConversationTurn
          message={{
            id: 'm2',
            senderLabel: 'reviewer',
            sentAt: '2026-09-11T12:01:00.000Z',
            body: 'Queue looks healthy.',
            thoughtSummary: 'I checked stale handoffs first.',
            provenance: 'VERIFIED',
          }}
          agentProfiles={{
            reviewer: { label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' },
          }}
          presenceByLabel={{
            reviewer: { state: 'AVAILABLE', lastActivityAt: new Date().toISOString() },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Queue looks healthy.')).toBeVisible();
    expect(screen.getByText('VERIFIED')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Thought/i }));
    expect(screen.getByText('I checked stale handoffs first.')).toBeVisible();
  });

  it('uses fallback thought text when no stored summary exists', () => {
    render(
      <MemoryRouter>
        <ConversationTurn
          message={{
            id: 'm3',
            senderLabel: 'reviewer',
            sentAt: '2026-09-11T12:02:00.000Z',
            body: 'Still working.',
          }}
          agentProfiles={{
            reviewer: { label: 'reviewer', displayName: 'Reviewer', trustLevel: 'VERIFIED' },
          }}
          presenceByLabel={{}}
          fallbackThought="reviewer: 2 recent messages"
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Thought/i }));
    expect(screen.getByText('reviewer: 2 recent messages')).toBeVisible();
  });
});

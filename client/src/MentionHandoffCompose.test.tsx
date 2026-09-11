import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from './App.test-setup';
import {
  MentionHandoffPreview,
  MessageLinkedHandoffs,
} from './components/MentionHandoffCompose';
import { useMentionHandoffCompose } from './components/useMentionHandoffCompose';
import { renderHook, act } from '@testing-library/react';

describe('MentionHandoffCompose', () => {
  it('offers known mentions and toggles confirmation', () => {
    const toggle = vi.fn();
    render(
      <MentionHandoffPreview
        offered={['cursor', 'reviewer']}
        confirmed={['cursor']}
        onToggle={toggle}
      />,
    );
    expect(screen.getByText('Open handoff to @cursor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open handoff to @reviewer' }));
    expect(toggle).toHaveBeenCalledWith('reviewer');
  });

  it('renders linked handoff state beside a message', () => {
    render(
      <MessageLinkedHandoffs
        handoffs={[{ id: 'h1', toAgentLabel: 'cursor', state: 'COMPLETED' }]}
      />,
    );
    expect(screen.getByText('Handoff to @cursor · COMPLETED')).toBeInTheDocument();
  });

  it('defaults confirmed mentions to every offered label', () => {
    const { result, rerender } = renderHook(
      ({ body, labels }) => useMentionHandoffCompose(body, labels),
      { initialProps: { body: '@cursor please help', labels: ['cursor'] } },
    );
    expect(result.current.confirmed).toEqual(['cursor']);
    rerender({ body: '@cursor and @reviewer', labels: ['cursor', 'reviewer'] });
    expect(result.current.confirmed).toEqual(['cursor', 'reviewer']);
    act(() => result.current.toggle('cursor'));
    expect(result.current.confirmed).toEqual(['reviewer']);
  });
});

import { GhdButton, GhdCard, GhdInput } from './components/DesignSystem';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('G.Holmes Designs component integration', () => {
  it('renders the shared button and card from the repository component bundle', () => {
    const onClick = vi.fn();
    render(
      <>
        <GhdButton onClick={onClick}>Save changes</GhdButton>
        <GhdCard title="Current work" className="workspace-card">
          Time entries appear here.
        </GhdCard>
      </>,
    );

    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toHaveClass('ghd-btn', 'ghd-btn-primary');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();

    expect(screen.getByText('Current work').closest('section')).toHaveClass(
      'ghd-card',
      'ghd-card-default',
      'workspace-card',
    );
    expect(screen.getByText('Time entries appear here.')).toBeVisible();
  });

  it('keeps input errors written, labeled, and connected to the field', () => {
    render(
      <GhdInput label="Task title" value="" onChange={() => undefined} error="Enter a title." />,
    );

    const input = screen.getByRole('textbox', { name: 'Task title' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Check this: Enter a title.');
    expect(screen.getByText('Check this: Enter a title.')).toBeVisible();
  });
});

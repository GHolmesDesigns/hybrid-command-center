import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AssistantApprovalCard } from './AssistantApprovalCard';

const approval = {
  id: 'ap-1',
  conversationId: 'conv-1',
  turnId: 'turn-1',
  toolName: 'workspace_update_task',
  toolArgs: { taskId: 'task-1', title: 'Review mockups' },
  tier: 'inline' as const,
  summary: { targetName: 'Launch checklist', targetId: 'task-1' },
  status: 'pending' as const,
  createdAt: '2026-09-17T12:00:00.000Z',
  expiresAt: '2026-09-17T12:15:00.000Z',
  decidedAt: null,
};

describe('AssistantApprovalCard', () => {
  it('renders inline approvals with tool arguments and target summary', () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    render(
      <AssistantApprovalCard approval={approval} onApprove={onApprove} onDecline={onDecline} />,
    );

    expect(screen.getByText('workspace_update_task')).toBeVisible();
    expect(screen.getByText(/Launch checklist \(task-1\)/)).toBeVisible();
    expect(screen.getByText(/Review mockups/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    fireEvent.click(screen.getByRole('button', { name: /Decline/i }));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it('labels blocking approvals differently', () => {
    render(
      <AssistantApprovalCard
        approval={{ ...approval, tier: 'blocking', toolName: 'workspace_delete_project' }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText('Confirm required')).toBeVisible();
    expect(screen.getByRole('button', { name: /Confirm approve/i })).toBeVisible();
  });

  it('renders without a target summary when none is provided', () => {
    render(
      <AssistantApprovalCard
        approval={{ ...approval, summary: null }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^Target:/)).toBeNull();
  });

  it('formats target summaries from alternate name and id fields', () => {
    render(
      <AssistantApprovalCard
        approval={{
          ...approval,
          summary: { name: 'Fallback name', id: 'fallback-id' },
        }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/Fallback name \(fallback-id\)/)).toBeVisible();
  });

  it('shows an id-only target summary', () => {
    render(
      <AssistantApprovalCard
        approval={{ ...approval, summary: { targetId: 'task-99' } }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/task-99/)).toBeVisible();
  });

  it('shows a name-only target summary', () => {
    render(
      <AssistantApprovalCard
        approval={{ ...approval, summary: { targetName: 'Launch checklist' } }}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/Launch checklist/)).toBeVisible();
    expect(screen.queryByText(/\(/)).toBeNull();
  });

  it('disables actions while busy', () => {
    render(
      <AssistantApprovalCard approval={approval} busy onApprove={vi.fn()} onDecline={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Decline/i })).toBeDisabled();
  });
});

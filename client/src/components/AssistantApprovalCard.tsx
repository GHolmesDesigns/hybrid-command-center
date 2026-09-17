import { Check, X } from 'lucide-react';
import type { AssistantPendingApproval } from '../../../shared/command-ai-assistant';

function formatSummary(summary: Record<string, unknown> | null): string | null {
  if (!summary) return null;
  const targetName =
    typeof summary.targetName === 'string'
      ? summary.targetName
      : typeof summary.name === 'string'
        ? summary.name
        : null;
  const targetId =
    typeof summary.targetId === 'string'
      ? summary.targetId
      : typeof summary.id === 'string'
        ? summary.id
        : null;
  if (targetName && targetId) return `${targetName} (${targetId})`;
  if (targetName) return targetName;
  if (targetId) return targetId;
  return null;
}

export function AssistantApprovalCard({
  approval,
  busy,
  onApprove,
  onDecline,
}: {
  approval: AssistantPendingApproval;
  busy?: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const target = formatSummary(approval.summary);
  const blocking = approval.tier === 'blocking';

  return (
    <article
      className={`assistant-approval-card ${blocking ? 'blocking' : 'inline'}`}
      aria-label={`${blocking ? 'Blocking' : 'Inline'} approval for ${approval.toolName}`}
    >
      <header className="assistant-approval-head">
        <strong>{approval.toolName}</strong>
        <span className={`assistant-approval-tier ${approval.tier}`}>
          {blocking ? 'Confirm required' : 'Inline approval'}
        </span>
      </header>
      {target && (
        <p className="assistant-approval-target">
          Target: <strong>{target}</strong>
        </p>
      )}
      <pre className="assistant-approval-args">{JSON.stringify(approval.toolArgs, null, 2)}</pre>
      <div className="assistant-approval-actions">
        <button
          type="button"
          className="secondary-btn"
          disabled={busy}
          onClick={onDecline}
        >
          <X aria-hidden="true" /> Decline
        </button>
        <button
          type="button"
          className={blocking ? 'primary-btn' : 'secondary-btn'}
          disabled={busy}
          onClick={onApprove}
        >
          <Check aria-hidden="true" /> {blocking ? 'Confirm approve' : 'Approve'}
        </button>
      </div>
    </article>
  );
}

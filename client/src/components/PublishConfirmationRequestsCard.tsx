import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { api, send } from '../api';

type QueueSummary = {
  pendingCount: number;
  oldestPendingAt: string | null;
  oldestPendingAgeMs: number | null;
  expiredCount: number;
  providerUncertainCount: number;
  limits: { pendingCount: number; pendingAgeMs: number };
};

type Request = {
  id: string;
  agentLabel: string;
  confirmation: string;
  status: string;
  createdAt: string;
  error: string | null;
};

export function PublishConfirmationRequestsCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await api<{ requests: Request[]; summary: QueueSummary }>(
      '/signal/publish-confirmations',
    );
    setRequests(result?.requests ?? []);
    setSummary(result?.summary ?? null);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const decide = async (id: string, action: 'approve' | 'deny') => {
    setBusy(id);
    try {
      await send(`/signal/publish-confirmations/${id}/${action}`, 'POST');
      await load();
      flash(
        action === 'approve'
          ? 'Publish confirmation approved and submitted.'
          : 'Publish confirmation denied.',
      );
    } catch (error) {
      flash((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const formatAge = (ageMs: number | null) => {
    if (ageMs === null) return '—';
    const minutes = Math.max(1, Math.floor(ageMs / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
  };

  return (
    <section className="panel settings-card" aria-labelledby="publish-confirmations-heading">
      <div className="settings-icon neutral">
        <CheckCircle2 />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Human approval</span>
          <h2 id="publish-confirmations-heading">Publish confirmations</h2>
        </div>
      </div>
      <p>
        Agent-initiated Signal publishing waits here for your exact approval. The provider is not
        contacted until you approve the unchanged preview.
      </p>
      {summary && (
        <p className="muted">
          Queue: {summary.pendingCount} pending · oldest {formatAge(summary.oldestPendingAgeMs)}
        </p>
      )}
      {requests.length === 0 ? (
        <p className="empty-state">No pending publish confirmations.</p>
      ) : (
        <ul className="agent-credential-list">
          {requests.map((request) => (
            <li key={request.id}>
              <div>
                <strong>{request.confirmation}</strong>
                <small>
                  Requested by {request.agentLabel} ·{' '}
                  <time dateTime={request.createdAt}>{request.createdAt}</time>
                </small>
              </div>
              {request.status === 'PENDING' ? (
                <div className="button-row">
                  <button
                    className="submit"
                    disabled={busy === request.id}
                    onClick={() => void decide(request.id, 'approve')}
                  >
                    {busy === request.id ? <RefreshCw className="spin" /> : <CheckCircle2 />}{' '}
                    Approve
                  </button>
                  <button
                    className="text-btn danger-text"
                    disabled={busy === request.id}
                    onClick={() => void decide(request.id, 'deny')}
                  >
                    <XCircle /> Deny
                  </button>
                </div>
              ) : (
                <small>
                  {request.status === 'EXPIRED'
                    ? 'Expired without operator action; no provider publish was attempted.'
                    : request.status === 'PROVIDER_UNCERTAIN'
                      ? 'Provider outcome is uncertain; inspect the provider before retrying.'
                      : `Terminal state: ${request.status}`}
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { api, send } from '../api';

type Request = {
  id: string;
  agentLabel: string;
  confirmation: string;
  status: string;
  createdAt: string;
  error: string | null;
};

export function DriveWriteRequestsCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await api<{ requests: Request[] }>('/drive-write-requests?status=PENDING');
    setRequests(result?.requests ?? []);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const decide = async (id: string, action: 'approve' | 'deny') => {
    setBusy(id);
    try {
      await send(`/drive-write-requests/${id}/${action}`, 'POST');
      await load();
      flash(action === 'approve' ? 'Drive write approved and executed.' : 'Drive write denied.');
    } catch (error) {
      flash((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel settings-card" aria-labelledby="drive-write-requests-heading">
      <div className="settings-icon neutral">
        <CheckCircle2 />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Human approval</span>
          <h2 id="drive-write-requests-heading">Drive write requests</h2>
        </div>
      </div>
      <p>
        Agents can request folder creation and uploads, but every Drive write waits here for your
        exact approval.
      </p>
      {requests.length === 0 ? (
        <p className="empty-state">No pending Drive write requests.</p>
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
              <div className="button-row">
                <button
                  className="submit"
                  disabled={busy === request.id}
                  onClick={() => void decide(request.id, 'approve')}
                >
                  {busy === request.id ? <RefreshCw className="spin" /> : <CheckCircle2 />} Approve
                </button>
                <button
                  className="text-btn danger-text"
                  disabled={busy === request.id}
                  onClick={() => void decide(request.id, 'deny')}
                >
                  <XCircle /> Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

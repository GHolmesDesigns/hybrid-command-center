import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Clock3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { WaitingInboxResponse } from '../../../shared/agent-waiting';
import { Empty } from './Primitives';

export function WaitingInboxCard({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<WaitingInboxResponse | null>(null);
  useEffect(() => {
    void api<WaitingInboxResponse>('/agent-waiting')
      .then((result) =>
        setData({
          items: Array.isArray(result?.items) ? result.items : [],
          warnings: Array.isArray(result?.warnings) ? result.warnings : [],
        }),
      )
      .catch(() => setData({ items: [], warnings: ['Waiting inbox is unavailable.'] }));
  }, []);
  return (
    <section
      className="panel settings-card"
      id="waiting-on-you"
      aria-labelledby="waiting-on-you-heading"
    >
      <div className="settings-icon neutral">
        <Clock3 />
      </div>
      <div>
        <div className="section-title">
          <div>
            <span className="eyebrow">Operator inbox</span>
            <h2 id="waiting-on-you-heading">
              Waiting on you <span className="handoff-count">{data?.items.length ?? 0}</span>
            </h2>
          </div>
          <Link className="text-btn" to="/agents">
            Open Agents <ArrowRight />
          </Link>
        </div>
        <p>Live sessions, stale handoffs, and pending Drive writes that need a person.</p>
        {data?.warnings.map((warning) => (
          <div className="inline-warning" role="status" key={warning}>
            <AlertCircle />
            <span>{warning}</span>
          </div>
        ))}
        {!data ? (
          <p className="muted">Loading inbox…</p>
        ) : data.items.length === 0 ? (
          <Empty compact title="Nothing waiting on you" body="The operator inbox is clear." />
        ) : (
          <ul className="agent-credential-list">
            {data.items.slice(0, compact ? 3 : 20).map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <div>
                  <strong>{item.destination}</strong>
                  <small>
                    {item.agent} · {item.detail}
                  </small>
                </div>
                <Link className="text-btn" to={item.resolutionPath}>
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Coins, HelpCircle, RefreshCw } from 'lucide-react';
import { api, send } from '../api';
import {
  AGENT_COST_ATTRIBUTION_DETAIL,
  AGENT_COST_PROVIDER_REPORTED,
  agentCostAttributionPhrase,
  type AgentCostSnapshot,
  type AgentCostSummary,
} from '../../../shared/agent-cost';

function formatQuantity(snapshot: AgentCostSnapshot): string {
  if (snapshot.unit === 'usd') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: snapshot.currency,
    }).format(snapshot.quantity);
  }
  return `${snapshot.quantity.toLocaleString()} ${snapshot.unit}`;
}

function SnapshotRow({ snapshot }: { snapshot: AgentCostSnapshot }) {
  const phrase = snapshot.attributionConfidence
    ? agentCostAttributionPhrase(snapshot.attributionConfidence)
    : undefined;
  const MatchIcon = phrase?.known ? BadgeCheck : HelpCircle;
  return (
    <li className="agent-cost-row">
      <p className="agent-cost-row-head">
        <strong>{snapshot.agentLabel ?? 'Unassigned usage'}</strong>
        <span className="agent-cost-model">{snapshot.model}</span>
      </p>
      <dl className="agent-cost-totals">
        <div className="agent-cost-total">
          <dt>Quantity</dt>
          <dd>{formatQuantity(snapshot)}</dd>
        </div>
        <div className="agent-cost-total">
          <dt>Provider</dt>
          <dd>{snapshot.provider}</dd>
        </div>
        <div className="agent-cost-total">
          <dt>Window</dt>
          <dd>
            {new Date(snapshot.windowStart).toLocaleString()} –{' '}
            {new Date(snapshot.windowEnd).toLocaleString()}
          </dd>
        </div>
      </dl>
      <p className="agent-cost-provenance">
        Provider reported this on {new Date(snapshot.snapshotAt).toLocaleString()}.
      </p>
      {phrase && (
        <p className="agent-cost-attribution">
          <span className="agent-cost-attribution-value">
            <MatchIcon aria-hidden="true" /> {phrase.text}
          </span>
          <span className="agent-cost-attribution-detail">{AGENT_COST_ATTRIBUTION_DETAIL}</span>
        </p>
      )}
    </li>
  );
}

export function AgentCostSnapshotsCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [summary, setSummary] = useState<AgentCostSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const next = await api<AgentCostSummary>('/agents/cost');
    setSummary(next);
    setError('');
  }, []);

  useEffect(() => {
    void load().catch((caught: unknown) => setError((caught as Error).message));
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      const next = await send<AgentCostSummary>('/agents/cost/refresh', 'POST');
      setSummary(next);
      if (next.reason) flash(next.reason, 'error');
      else flash('Agent usage refreshed from the provider.');
    } catch (caught) {
      flash((caught as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card agent-cost-card" aria-labelledby="agent-cost-heading">
      <div className="card-head">
        <h2 id="agent-cost-heading">
          <Coins aria-hidden="true" /> Agent usage
        </h2>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void refresh()}
          disabled={busy || summary?.available === false}
        >
          <RefreshCw aria-hidden="true" /> Refresh usage
        </button>
      </div>
      <p className="agent-cost-note">{AGENT_COST_PROVIDER_REPORTED}</p>
      {error && <p className="error">{error}</p>}
      {!summary ? (
        <p>Loading usage snapshots…</p>
      ) : !summary.available ? (
        <p className="agent-cost-unavailable">Agent cost needs CURSOR_ADMIN_API_KEY.</p>
      ) : summary.snapshots.length === 0 ? (
        <p className="agent-cost-unavailable">
          No provider-reported usage is stored yet. Refresh when the provider exposes billing
          figures.
        </p>
      ) : (
        <>
          {summary.lastRefreshAt && (
            <p className="agent-cost-meta">
              Last refresh {new Date(summary.lastRefreshAt).toLocaleString()}.
            </p>
          )}
          {summary.reason && <p className="agent-cost-reason">{summary.reason}</p>}
          <ul className="agent-cost-rows">
            {summary.snapshots.map((snapshot) => (
              <SnapshotRow key={snapshot.id} snapshot={snapshot} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

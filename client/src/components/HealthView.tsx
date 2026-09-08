import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Activity, Database, Bot, Radio } from 'lucide-react';
import { api } from '../api';
import type { AppHealthResponse } from '../../../shared/app-health';
import { PageHead } from './Shell';

const icons = { process: Activity, database: Database, agentActivity: Bot, remoteAgents: Radio };
export function HealthView() {
  const [health, setHealth] = useState<AppHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await api<AppHealthResponse>('/health/dashboard'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="page">
      <PageHead
        eyebrow="Operations"
        title="Application health"
        body="A read-only view of liveness, readiness, historical activity, and current remote-agent evidence."
        action={
          <button onClick={() => void refresh()} disabled={loading}>
            <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} />
            {loading ? 'Checking…' : 'Re-check health'}
          </button>
        }
      />
      {error && (
        <p role="alert" className="notice error">
          Health check failed: {error}
        </p>
      )}
      {health && (
        <>
          <p role="status" className="refresh-status">
            Overall status: <strong>{health.overall}</strong> · Last aggregate check:{' '}
            {new Date(health.generatedAt).toLocaleString()}
          </p>
          <div className="card-grid health-grid">
            {(
              Object.entries(health.signals) as [
                keyof AppHealthResponse['signals'],
                AppHealthResponse['signals'][keyof AppHealthResponse['signals']],
              ][]
            ).map(([key, signal]) => {
              const Icon = icons[key];
              return (
                <section className={`card health-card health-${signal.state}`} key={key}>
                  <div className="health-card-heading">
                    <Icon aria-hidden="true" />
                    <h2>{signal.label}</h2>
                  </div>
                  <p>
                    <strong>{signal.state}</strong>
                  </p>
                  <p>{signal.detail}</p>
                  <small>{signal.freshness}</small>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

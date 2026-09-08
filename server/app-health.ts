import type { Db } from './db.ts';
import { listMcpAgentCredentials } from './auth/mcp-agent-credentials.ts';
import { buildMcpHealthPanel } from './mcp/health-panel.ts';
import type { AppHealthResponse, AppHealthState } from '../shared/app-health.ts';

const freshness = (checkedAt: string | null, now: number) => {
  if (!checkedAt) return 'Not checked yet';
  const age = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 60000));
  return age === 0 ? 'Checked just now' : `Checked ${age} minute${age === 1 ? '' : 's'} ago`;
};

export function buildAppHealth(
  db: Db,
  options: { now?: Date; authRequired: boolean },
): AppHealthResponse {
  const nowDate = options.now ?? new Date();
  const now = nowDate.getTime();
  const checkedAt = nowDate.toISOString();
  const signals: AppHealthResponse['signals'] = {
    process: {
      state: 'healthy',
      label: 'Process liveness',
      detail: 'The application process is responding.',
      checkedAt,
      freshness: freshness(checkedAt, now),
    },
    database: {
      state: 'healthy',
      label: 'Database readiness',
      detail: 'SQLite accepted a readiness query.',
      checkedAt,
      freshness: freshness(checkedAt, now),
    },
    agentActivity: {
      state: 'degraded',
      label: 'Historical agent activity',
      detail: 'No agent activity has been recorded yet.',
      checkedAt: null,
      freshness: 'No activity recorded',
    },
    remoteAgents: {
      state: 'degraded',
      label: 'Active remote-agent verification',
      detail: 'No remote agent has checked in yet.',
      checkedAt: null,
      freshness: 'Not verified yet',
    },
  };
  try {
    db.prepare('SELECT 1').get();
  } catch {
    signals.database = {
      ...signals.database,
      state: 'unavailable',
      detail: 'The database readiness query failed.',
    };
  }
  try {
    const panel = buildMcpHealthPanel(db, { enabled: options.authRequired, now: nowDate });
    if (panel.auditEventCount > 0) {
      signals.agentActivity = {
        ...signals.agentActivity,
        state: panel.state === 'all_failed' ? 'degraded' : 'healthy',
        detail: `${panel.auditEventCount} historical agent event${panel.auditEventCount === 1 ? '' : 's'} available.`,
        checkedAt: panel.generatedAt,
        freshness: freshness(panel.generatedAt, now),
      };
    }
    const credentials = options.authRequired ? listMcpAgentCredentials(db, now) : [];
    const active = credentials.filter((credential) => credential.lastUsedAt);
    if (active.length > 0) {
      const latest = active
        .map((credential) => credential.lastUsedAt!)
        .sort()
        .at(-1)!;
      signals.remoteAgents = {
        ...signals.remoteAgents,
        state: 'healthy',
        detail: `${active.length} registered remote agent${active.length === 1 ? '' : 's'} has checked in.`,
        checkedAt: latest,
        freshness: freshness(latest, now),
      };
    }
  } catch {
    signals.agentActivity = {
      ...signals.agentActivity,
      state: 'unavailable',
      detail: 'Historical agent activity could not be read.',
    };
  }
  const states = Object.values(signals).map((signal) => signal.state);
  const overall: AppHealthState = states.includes('unavailable')
    ? 'unavailable'
    : states.includes('degraded')
      ? 'degraded'
      : 'healthy';
  return { generatedAt: checkedAt, overall, signals };
}

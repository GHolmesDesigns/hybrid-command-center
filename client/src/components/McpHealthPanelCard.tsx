import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, PlugZap, RefreshCw } from 'lucide-react';
import { api, send } from '../api';
import { type McpCoordinationErrorCode } from '../../../shared/mcp-coordination-errors';
import type { McpConnectionStatus, McpHealthPanel } from '../../../shared/mcp-health';

type HealthTestResponse = {
  ok: boolean;
  status: McpConnectionStatus;
  workspaceChecksumUnchanged: boolean;
  lastUsedAt: string;
};

const PANEL_STATE_LABEL: Record<McpHealthPanel['state'], string> = {
  never_connected: 'No agent has connected yet',
  all_failed: 'Agents connected, but every audited call failed',
  mixed: 'Mixed success and failure',
  healthy: 'Agents are connecting normally',
  unavailable: 'Health data unavailable',
};

const ERROR_CODE_LABEL: Record<McpCoordinationErrorCode, string> = {
  COORDINATION_AGENT_LABEL_REQUIRED: 'Agent label required',
  COORDINATION_SESSION_LABEL_MISMATCH: 'Session label mismatch',
  COORDINATION_CREDENTIAL_LABEL_MISMATCH: 'Credential label mismatch',
  COORDINATION_SCOPE_REQUIRED: 'Coordination scope required',
  WORKSPACE_SCOPE_REQUIRED: 'Workspace scope required',
  COORDINATION_RATE_LIMIT_EXCEEDED: 'Rate limit exceeded',
  COORDINATION_UNAUTHORIZED: 'Unauthorized',
  COORDINATION_INVALID_STATE: 'Invalid handoff state',
  COORDINATION_NOT_FOUND: 'Handoff not found',
  COORDINATION_INVALID_ARGUMENTS: 'Invalid arguments',
  COORDINATION_UNKNOWN_TOOL: 'Unknown tool',
  COORDINATION_TOOL_FAILED: 'Tool failed',
};

export function McpHealthPanelCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [panel, setPanel] = useState<McpHealthPanel | null>(null);
  const [testResult, setTestResult] = useState<HealthTestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const next = await api<McpHealthPanel>('/mcp/health');
    setPanel(next);
    setError('');
  }, []);

  useEffect(() => {
    void load().catch((caught: unknown) => setError((caught as Error).message));
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      await load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const result = await send<HealthTestResponse>('/mcp/health/test', 'POST');
      setTestResult(result);
      await load();
      if (result.ok) {
        flash('Connection test succeeded.');
      } else {
        flash('Connection test completed with failures.', 'error');
      }
    } catch (caught) {
      flash((caught as Error).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const headlineIcon =
    panel?.state === 'healthy' ? (
      <CheckCircle2 aria-hidden="true" />
    ) : panel?.state === 'unavailable' || panel?.state === 'all_failed' ? (
      <AlertTriangle aria-hidden="true" />
    ) : (
      <Activity aria-hidden="true" />
    );

  return (
    <section className="panel settings-card mcp-health-card" aria-labelledby="mcp-health-heading">
      <div className="settings-icon neutral">
        <PlugZap />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Network MCP</span>
          <h2 id="mcp-health-heading">Connection health</h2>
        </div>
        <button
          type="button"
          className="secondary icon-btn"
          onClick={() => void refresh()}
          disabled={busy || testing}
          aria-label="Refresh MCP health"
        >
          <RefreshCw className={busy ? 'spin' : undefined} />
        </button>
      </div>
      <p>
        See which agents have connected, how recent calls succeeded or were refused, and run a safe
        diagnostic that never creates a handoff.
      </p>
      {error && <p role="alert">{error}</p>}
      {panel && !panel.enabled ? (
        <p className="field-hint">Available when operator authentication enables network MCP.</p>
      ) : (
        <>
          {panel && (
            <div className="mcp-health-headline" aria-live="polite">
              {headlineIcon}
              <div>
                <strong>{PANEL_STATE_LABEL[panel.state]}</strong>
                {panel.stateReason && <p className="mcp-health-note">{panel.stateReason}</p>}
              </div>
            </div>
          )}
          <div className="mcp-health-actions">
            <button
              type="button"
              className="submit"
              disabled={testing || busy || !panel?.enabled}
              onClick={() => void testConnection()}
            >
              {testing ? <RefreshCw className="spin" /> : <PlugZap />} Test connection
            </button>
          </div>
          {testResult && (
            <div className="mcp-health-test-result" role="status">
              <strong>
                {testResult.ok ? 'Diagnostic passed' : 'Diagnostic reported failures'}
              </strong>
              <span>Server clock: {new Date(testResult.status.serverClock).toLocaleString()}</span>
              <span>Capability version: {testResult.status.capabilityVersion}</span>
              <span>Tools listed: {testResult.status.checks.toolsList.toolCount ?? 0}</span>
              <span>Last tested: {new Date(testResult.lastUsedAt).toLocaleString()}</span>
              {!testResult.workspaceChecksumUnchanged && (
                <span role="alert">Workspace checksum changed during the test.</span>
              )}
            </div>
          )}
          {panel?.agents.length ? (
            <ul className="mcp-health-agent-list">
              {panel.agents.map((agent) => (
                <li key={agent.label}>
                  <strong>{agent.label}</strong>
                  <span>
                    Requests: {agent.requestCount} · Refused: {agent.refusalCount} · Rate limits:{' '}
                    {agent.rateLimitCount}
                  </span>
                  <small>
                    Last used:{' '}
                    {agent.lastUsedAt
                      ? new Date(agent.lastUsedAt).toLocaleString()
                      : 'Never recorded'}
                    {agent.lastOrigin ? ` from ${agent.lastOrigin}` : ''}
                  </small>
                  <small>
                    Last success:{' '}
                    {agent.lastSuccessAt
                      ? new Date(agent.lastSuccessAt).toLocaleString()
                      : 'None recorded'}
                  </small>
                  <small>
                    Last failure:{' '}
                    {agent.lastFailureAt
                      ? new Date(agent.lastFailureAt).toLocaleString()
                      : 'None recorded'}
                  </small>
                </li>
              ))}
            </ul>
          ) : panel?.state === 'never_connected' ? (
            <p className="empty-state">No agent activity recorded yet.</p>
          ) : panel?.state === 'all_failed' ? (
            <p className="empty-state">Every audited call failed or was refused.</p>
          ) : null}
          {panel?.errorSummary.length ? (
            <div className="mcp-health-errors">
              <h3>Error codes (recent audit)</h3>
              <ul>
                {panel.errorSummary.map((row) => (
                  <li key={row.code}>
                    {ERROR_CODE_LABEL[row.code] ?? row.code}: {row.count}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {panel?.staleHandoffs.length ? (
            <div className="mcp-health-stale">
              <h3>Stale handoffs</h3>
              <ul>
                {panel.staleHandoffs.map((handoff) => (
                  <li key={handoff.id}>
                    <strong>{handoff.state}</strong> · {handoff.fromAgentLabel} ·{' '}
                    {handoff.subjectType}
                    {handoff.subjectId ? ` ${handoff.subjectId}` : ''}
                    <small>
                      Stale since {new Date(handoff.staleSince).toLocaleDateString()} (
                      {handoff.reason === 'open_ttl' ? 'open TTL' : 'long-running claim'})
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

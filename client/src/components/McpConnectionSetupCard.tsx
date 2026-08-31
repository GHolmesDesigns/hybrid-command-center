import { useCallback, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import {
  Activity,
  CheckCircle2,
  Copy,
  KeyRound,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api, send } from '../api';
import {
  MCP_AGENT_SCOPES,
  type McpAgentCredentialList,
  type McpAgentCredentialSummary,
  type McpAgentScope,
} from '../../../shared/mcp-agent-registry';
import {
  MCP_CLIENT_PLATFORMS,
  MCP_CLIENT_PLATFORM_LABEL,
  type McpClientPlatform,
} from '../../../shared/mcp-client-config';
import {
  buildMcpClientGuide,
  MCP_GUIDE_CLAUDE_CONNECTOR_BLOCKER,
} from '../../../shared/mcp-client-guide';
import type { McpConnectionStatus } from '../../../shared/mcp-health';

type RegistryResponse = McpAgentCredentialList & { enabled: boolean };
type IssuedResponse = {
  ok: true;
  bearerToken: string;
  credential: McpAgentCredentialSummary;
};
type HealthTestResponse = {
  ok: boolean;
  status: McpConnectionStatus;
  workspaceChecksumUnchanged: boolean;
  lastUsedAt: string;
};

const SCOPE_LABEL: Record<McpAgentScope, string> = {
  'coordination:read': 'Read coordination',
  'coordination:write': 'Write coordination',
  'workspace:read': 'Read workspace (reserved)',
  'workspace:write': 'Write workspace (reserved)',
};

const DEFAULT_SCOPES: McpAgentScope[] = ['coordination:read', 'coordination:write'];

const credentialExpiryIso = (daysValid: number, nowMs: number): string =>
  new Date(nowMs + daysValid * 86_400_000).toISOString();

export function McpConnectionSetupCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<McpAgentScope[]>(DEFAULT_SCOPES);
  const [days, setDays] = useState(30);
  const [issued, setIssued] = useState<IssuedResponse | null>(null);
  const [platform, setPlatform] = useState<McpClientPlatform>('cursor');
  const [testResult, setTestResult] = useState<HealthTestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const next = await api<RegistryResponse>('/auth/mcp-agents');
    setRegistry(next);
    setError('');
  }, []);

  useEffect(() => {
    void load().catch((caught: unknown) => setError((caught as Error).message));
  }, [load]);

  const toggleScope = (scope: McpAgentScope) => {
    setScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    );
  };

  const issue = async (event: FormEvent) => {
    event.preventDefault();
    if (!scopes.length) return flash('Choose at least one capability scope.', 'error');
    setBusy(true);
    try {
      const result = await send<IssuedResponse>('/auth/mcp-agents', 'POST', {
        label,
        scopes,
        expiresAt: credentialExpiryIso(days, Date.now()),
      });
      setIssued(result);
      setLabel('');
      setTestResult(null);
      await load();
      flash('Credential issued. Follow the steps below — copy once; it cannot be recovered later.');
    } catch (caught) {
      flash((caught as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (credential: McpAgentCredentialSummary) => {
    if (!confirm(`Revoke the credential for ${credential.label}? Other agents remain connected.`))
      return;
    try {
      await send(`/auth/mcp-credentials/${credential.id}/revoke`, 'POST');
      if (issued?.credential.id === credential.id) setIssued(null);
      await load();
      flash(`${credential.label} credential revoked.`);
    } catch (caught) {
      flash((caught as Error).message, 'error');
    }
  };

  const rotateFor =
    (credential: McpAgentCredentialSummary) => async (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (
        !confirm(
          `Rotate the credential for ${credential.label}? The old key stops working immediately. A new key is shown once.`,
        )
      ) {
        return;
      }
      setRotatingId(credential.id);
      try {
        await send(`/auth/mcp-credentials/${credential.id}/revoke`, 'POST');
        const result = await send<IssuedResponse>('/auth/mcp-agents', 'POST', {
          label: credential.label,
          scopes: credential.scopes,
          expiresAt: credentialExpiryIso(days, Date.now()),
        });
        setIssued(result);
        setTestResult(null);
        await load();
        flash(
          `${credential.label} rotated. Copy the new setup below, update your client, then run the diagnostic.`,
        );
      } catch (caught) {
        flash((caught as Error).message, 'error');
      } finally {
        setRotatingId(null);
      }
    };

  const guide = useMemo(() => {
    if (!issued) return null;
    try {
      return buildMcpClientGuide({
        platform,
        agentLabel: issued.credential.label,
        origin: window.location.origin,
        bearerToken: issued.bearerToken,
      });
    } catch (caught) {
      return { error: (caught as Error).message };
    }
  }, [issued, platform]);

  const copyValue = async (value: string, successMessage: string) => {
    await navigator.clipboard.writeText(value);
    flash(successMessage);
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const result = await send<HealthTestResponse>('/mcp/health/test', 'POST');
      setTestResult(result);
      if (result.ok) {
        flash('Connection diagnostic passed.');
      } else {
        flash('Diagnostic completed with failures.', 'error');
      }
    } catch (caught) {
      flash((caught as Error).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const activeCredential = issued
    ? registry?.credentials.find((row) => row.id === issued.credential.id)
    : null;

  return (
    <section className="panel settings-card" aria-labelledby="mcp-setup-heading">
      <div className="settings-icon neutral">
        <KeyRound />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Network MCP</span>
          <h2 id="mcp-setup-heading">Agent connection setup</h2>
        </div>
      </div>
      <p>
        Register an agent, issue or rotate a credential, follow the numbered steps for your client,
        and run the read-only diagnostic. Hosted HTTPS only — no terminal and no hand-edited config
        files.
      </p>
      {error && <p role="alert">{error}</p>}
      {registry && !registry.enabled ? (
        <p className="field-hint">Available when operator authentication enables network MCP.</p>
      ) : (
        <>
          <ol className="mcp-setup-steps">
            <li>
              <strong>1. Register and issue</strong>
              <form className="form agent-credential-form" onSubmit={issue}>
                <label>
                  Agent label
                  <input
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="cursor-planning"
                    maxLength={64}
                    pattern="[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?"
                    required
                  />
                </label>
                <fieldset>
                  <legend>Capability scopes</legend>
                  {MCP_AGENT_SCOPES.map((scope) => (
                    <label className="checkbox-row" key={scope}>
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      {SCOPE_LABEL[scope]}
                    </label>
                  ))}
                </fieldset>
                <label>
                  Expires after
                  <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                  </select>
                </label>
                <button className="submit" disabled={busy || !scopes.length}>
                  {busy ? <RefreshCw className="spin" /> : <ShieldCheck />} Issue credential
                </button>
              </form>
            </li>
            <li aria-disabled={!issued}>
              <strong>2. Connect your client</strong>
              {!issued ? (
                <p className="field-hint">
                  Issue or rotate a credential to unlock the connection steps.
                </p>
              ) : guide && 'error' in guide ? (
                <p role="alert">{guide.error}</p>
              ) : guide ? (
                <>
                  <label>
                    Client
                    <select
                      value={platform}
                      onChange={(event) => setPlatform(event.target.value as McpClientPlatform)}
                    >
                      {MCP_CLIENT_PLATFORMS.map((item) => (
                        <option key={item} value={item}>
                          {MCP_CLIENT_PLATFORM_LABEL[item]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="field-hint" role="status">
                    Credential for <strong>{issued.credential.label}</strong> is shown once. Copy it
                    now. {guide.headerHint}
                  </p>
                  {platform === 'claude-desktop' ? (
                    <p className="field-hint mcp-guide-blocker" role="note">
                      {MCP_GUIDE_CLAUDE_CONNECTOR_BLOCKER}
                    </p>
                  ) : null}
                  <ol className="mcp-guide-steps">
                    {guide.steps.map((step) => (
                      <li key={step.title}>
                        <strong>{step.title}</strong>
                        <p>{step.body}</p>
                      </li>
                    ))}
                  </ol>
                  <div className="mcp-guide-copy-actions">
                    {guide.copyFields.map((field) => (
                      <button
                        key={field.id}
                        type="button"
                        className={field.id === 'setup' ? 'submit' : 'secondary'}
                        onClick={() =>
                          void copyValue(
                            field.value,
                            field.id === 'setup'
                              ? 'Ready-to-paste setup copied.'
                              : `${field.label.replace(/^Copy /, '')} copied.`,
                          )
                        }
                      >
                        <Copy /> {field.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </li>
            <li>
              <strong>3. Run diagnostic</strong>
              <p className="field-hint">
                Safe read-only check — never creates a test handoff. After configuring your client
                and reloading MCP, your agent&apos;s first call updates <strong>Last used</strong>{' '}
                below.
              </p>
              <div className="mcp-health-actions">
                <button
                  type="button"
                  className="submit"
                  disabled={testing || busy || !registry?.enabled}
                  onClick={() => void testConnection()}
                >
                  {testing ? <RefreshCw className="spin" /> : <PlugZap />} Run connection diagnostic
                </button>
              </div>
              {testResult && (
                <div className="mcp-health-test-result" role="status">
                  <strong>
                    {testResult.ok ? (
                      <>
                        <CheckCircle2 aria-hidden="true" /> Diagnostic passed
                      </>
                    ) : (
                      <>
                        <Activity aria-hidden="true" /> Diagnostic reported failures
                      </>
                    )}
                  </strong>
                  <span>
                    Server clock: {new Date(testResult.status.serverClock).toLocaleString()}
                  </span>
                  <span>Capability version: {testResult.status.capabilityVersion}</span>
                  <span title={testResult.status.storeId}>
                    Store: {testResult.status.storeId.slice(0, 8)}
                  </span>
                  <span>Tools listed: {testResult.status.checks.toolsList.toolCount ?? 0}</span>
                  <span>Last tested: {new Date(testResult.lastUsedAt).toLocaleString()}</span>
                  {!testResult.workspaceChecksumUnchanged && (
                    <span role="alert">Workspace checksum changed during the test.</span>
                  )}
                </div>
              )}
              {activeCredential && (
                <p className="mcp-setup-connection-status" role="status">
                  {activeCredential.lastUsedAt ? (
                    <>
                      <CheckCircle2 aria-hidden="true" /> {activeCredential.label} last connected{' '}
                      {new Date(activeCredential.lastUsedAt).toLocaleString()}
                      {activeCredential.lastOrigin ? ` from ${activeCredential.lastOrigin}` : ''}
                    </>
                  ) : (
                    <>Waiting for {activeCredential.label} to connect from your MCP client.</>
                  )}
                </p>
              )}
            </li>
          </ol>
          <ul className="agent-credential-list">
            {registry?.credentials.map((credential) => (
              <li key={credential.id}>
                <div>
                  <strong>{credential.label}</strong>
                  <span>{credential.scopes.join(' · ')}</span>
                  <small>
                    Last used:{' '}
                    {credential.lastUsedAt
                      ? new Date(credential.lastUsedAt).toLocaleString()
                      : 'Never'}
                    {credential.lastOrigin ? ` from ${credential.lastOrigin}` : ''}
                  </small>
                </div>
                <div className="agent-credential-actions">
                  <button
                    type="button"
                    className="text-btn"
                    disabled={rotatingId === credential.id || busy}
                    onClick={(event) => void rotateFor(credential)(event)}
                    aria-label={`Rotate ${credential.label}`}
                  >
                    {rotatingId === credential.id ? <RefreshCw className="spin" /> : <RefreshCw />}{' '}
                    Rotate
                  </button>
                  <button
                    type="button"
                    className="text-btn danger-text"
                    onClick={() => void revoke(credential)}
                    aria-label={`Revoke ${credential.label}`}
                  >
                    <Trash2 /> Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {registry?.credentials.length === 0 && (
            <p className="empty-state">No active agent credentials.</p>
          )}
        </>
      )}
    </section>
  );
}

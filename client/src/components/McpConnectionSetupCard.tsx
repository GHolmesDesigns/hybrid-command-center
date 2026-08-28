import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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
  MCP_CLIENT_TRANSPORTS,
  MCP_CLIENT_PLATFORM_LABEL,
  MCP_CLIENT_TRANSPORT_LABEL,
  buildMcpClientConfig,
  type McpClientPlatform,
  type McpClientTransport,
} from '../../../shared/mcp-client-config';
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

export function McpConnectionSetupCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<McpAgentScope[]>([
    'coordination:read',
    'coordination:write',
  ]);
  const [days, setDays] = useState(30);
  const [issued, setIssued] = useState<IssuedResponse | null>(null);
  const [platform, setPlatform] = useState<McpClientPlatform>('cursor');
  const [transport, setTransport] = useState<McpClientTransport>('stdio');
  const [repoPath, setRepoPath] = useState('');
  const [testResult, setTestResult] = useState<HealthTestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
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
        expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      });
      setIssued(result);
      setLabel('');
      setTestResult(null);
      await load();
      flash('Agent credential issued. Generate client configuration below.');
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

  const generatedConfig = useMemo(() => {
    if (!issued) return null;
    try {
      return buildMcpClientConfig({
        platform,
        transport,
        agentLabel: issued.credential.label,
        origin: window.location.origin,
        repoPath: repoPath.trim() || undefined,
        bearerToken: issued.bearerToken,
        embedSecret: transport === 'http',
      });
    } catch (caught) {
      return { error: (caught as Error).message };
    }
  }, [issued, platform, transport, repoPath]);

  const copyConfig = async () => {
    if (!generatedConfig || 'error' in generatedConfig) return;
    await navigator.clipboard.writeText(generatedConfig.content);
    flash('Configuration copied.');
  };

  const copySecret = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.bearerToken);
    flash('Credential copied.');
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
        Register an agent, issue a scoped credential once, generate copy-ready client configuration,
        run the read-only diagnostic, and confirm the agent&apos;s last connection here.
      </p>
      {error && <p role="alert">{error}</p>}
      {registry && !registry.enabled ? (
        <p className="field-hint">Available when operator authentication enables network MCP.</p>
      ) : (
        <>
          <ol className="mcp-setup-steps">
            <li>
              <strong>Register and issue</strong>
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
              <strong>Generate client configuration</strong>
              {!issued ? (
                <p className="field-hint">Issue a credential to unlock configuration generation.</p>
              ) : (
                <>
                  <div className="form-row">
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
                    <label>
                      Transport
                      <select
                        value={transport}
                        onChange={(event) => setTransport(event.target.value as McpClientTransport)}
                      >
                        {MCP_CLIENT_TRANSPORTS.map((item) => (
                          <option key={item} value={item}>
                            {MCP_CLIENT_TRANSPORT_LABEL[item]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {platform === 'codex' && transport === 'stdio' && (
                    <label>
                      Repository path (absolute)
                      <input
                        value={repoPath}
                        onChange={(event) => setRepoPath(event.target.value)}
                        placeholder="C:\Users\you\hybrid-command-center"
                        required
                      />
                    </label>
                  )}
                  {generatedConfig && 'error' in generatedConfig ? (
                    <p role="alert">{generatedConfig.error}</p>
                  ) : generatedConfig ? (
                    <div className="issued-credential mcp-generated-config">
                      <strong>
                        Copy into {generatedConfig.filename}
                        {generatedConfig.secretEmbedded ? ' (includes credential)' : ''}
                      </strong>
                      <pre>{generatedConfig.content}</pre>
                      <button type="button" className="secondary" onClick={() => void copyConfig()}>
                        <Copy /> Copy configuration
                      </button>
                      {transport === 'http' && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void copySecret()}
                        >
                          <Copy /> Copy credential only
                        </button>
                      )}
                      <ul className="mcp-config-notes">
                        {generatedConfig.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
            </li>
            <li>
              <strong>Run diagnostic</strong>
              <p className="field-hint">
                Safe read-only check — never creates a test handoff. After pasting configuration
                into your client and reloading MCP, your agent&apos;s first call updates{' '}
                <strong>Last used</strong> below.
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
                <button
                  type="button"
                  className="text-btn danger-text"
                  onClick={() => void revoke(credential)}
                  aria-label={`Revoke ${credential.label}`}
                >
                  <Trash2 /> Revoke
                </button>
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

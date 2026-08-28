import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api, send } from '../api';
import {
  MCP_AGENT_SCOPES,
  type McpAgentCredentialList,
  type McpAgentCredentialSummary,
  type McpAgentScope,
} from '../../../shared/mcp-agent-registry';

type RegistryResponse = McpAgentCredentialList & { enabled: boolean };
type IssuedResponse = {
  ok: true;
  bearerToken: string;
  credential: McpAgentCredentialSummary;
};

const SCOPE_LABEL: Record<McpAgentScope, string> = {
  'coordination:read': 'Read coordination',
  'coordination:write': 'Write coordination',
  'workspace:read': 'Read workspace (reserved)',
  'workspace:write': 'Write workspace (reserved)',
};

export function McpAgentCredentialsCard({
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
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      setIssuedSecret(result.bearerToken);
      setLabel('');
      await load();
      flash('Agent credential issued. Copy it now; it will not be shown again.');
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
      await load();
      flash(`${credential.label} credential revoked.`);
    } catch (caught) {
      flash((caught as Error).message, 'error');
    }
  };

  const copySecret = async () => {
    if (!issuedSecret) return;
    await navigator.clipboard.writeText(issuedSecret);
    flash('Credential copied.');
  };

  return (
    <section className="panel settings-card" aria-labelledby="mcp-agents-heading">
      <div className="settings-icon neutral">
        <KeyRound />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Network MCP</span>
          <h2 id="mcp-agents-heading">Agent credentials</h2>
        </div>
      </div>
      <p>
        Register one server-bound identity per agent. Secrets are stored only as hashes and shown
        once, when issued.
      </p>
      {error && <p role="alert">{error}</p>}
      {registry && !registry.enabled ? (
        <p className="field-hint">Available when operator authentication enables network MCP.</p>
      ) : (
        <>
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
          {issuedSecret && (
            <div className="issued-credential" role="status">
              <strong>Copy this credential now</strong>
              <code>{issuedSecret}</code>
              <button type="button" className="secondary" onClick={() => void copySecret()}>
                <Copy /> Copy credential
              </button>
              <small>It disappears when this page reloads and cannot be recovered.</small>
            </div>
          )}
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

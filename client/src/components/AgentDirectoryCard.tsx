import { useEffect, useState } from 'react';
import { api } from '../api';
import { Empty } from './Primitives';
import { isAgentActivityStale } from '../../../shared/agent-summaries';
import { AGENT_PROFILE_CHARTER_MAX } from '../../../shared/agent-directory';

type Capability = { name: string; description: string | null };
type Agent = {
  id: string;
  label: string;
  displayName: string;
  bio: string | null;
  charter: string | null;
  trustLevel: string;
  availability: string;
  lastVerifiedAt: string | null;
  capabilities: Capability[];
};
type Presence = {
  agentLabel: string;
  state: string;
  availability: string | null;
  verifiedAt: string;
  lastActivityAt: string | null;
};

export function AgentDirectoryCard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState('');
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [summaries, setSummaries] = useState<
    Record<string, { text: string; generatedAt: string; evidence: string[] }>
  >({});
  const [filter, setFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [charterDrafts, setCharterDrafts] = useState<Record<string, string>>({});
  const [savingCharter, setSavingCharter] = useState<string | null>(null);
  const [charterStatus, setCharterStatus] = useState<Record<string, string>>({});
  const load = async () => {
    setRefreshing(true);
    try {
      const [directory, live, current] = await Promise.all([
        api<{ agents?: Agent[] }>('/agents/directory'),
        api<{ presence?: Presence[] }>('/agents/presence'),
        api<{
          summaries?: Array<{
            agentLabel: string;
            text: string;
            generatedAt: string;
            evidence: string[];
          }>;
        }>('/agent-summaries'),
      ]);
      const nextAgents = Array.isArray(directory.agents)
        ? directory.agents.filter(Boolean).map((agent) => ({
            ...agent,
            id: agent.id ?? agent.label,
            label: agent.label ?? 'Unknown agent',
            displayName: agent.displayName ?? agent.label ?? 'Unknown agent',
            availability: agent.availability ?? 'UNKNOWN',
            trustLevel: agent.trustLevel ?? 'UNVERIFIED',
            charter: agent.charter ?? null,
            capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
          }))
        : [];
      setAgents(nextAgents);
      setCharterDrafts(
        Object.fromEntries(nextAgents.map((agent) => [agent.id, agent.charter ?? ''])),
      );
      setCharterStatus({});
      setPresence(
        Object.fromEntries((live.presence ?? []).map((row) => [row.agentLabel.toLowerCase(), row])),
      );
      setSummaries(
        Object.fromEntries(
          (current.summaries ?? []).map((row) => [row.agentLabel.toLowerCase(), row]),
        ),
      );
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const saveCharter = async (agent: Agent) => {
    const charter = charterDrafts[agent.id] ?? '';
    setSavingCharter(agent.id);
    setCharterStatus({});
    try {
      const result = await api<{ agent?: Agent }>(`/agents/${agent.id}/profile`, {
        method: 'PATCH',
        body: JSON.stringify({ charter }),
      });
      const updated = result.agent;
      if (updated) {
        setAgents((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
        setCharterDrafts((current) => ({ ...current, [agent.id]: updated.charter ?? '' }));
      }
      setCharterStatus({ [agent.id]: 'Charter saved.' });
    } catch (problem) {
      setCharterStatus({ [agent.id]: (problem as Error).message });
    } finally {
      setSavingCharter(null);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section
      className="panel settings-card"
      id="agent-directory"
      aria-labelledby="agent-directory-heading"
    >
      <div className="section-title">
        <div>
          <span className="eyebrow">Identity</span>
          <h2 id="agent-directory-heading">Agent directory</h2>
        </div>
      </div>
      <p>
        Human-readable profiles and declared capabilities. Credentials and secrets are never shown
        here.
      </p>
      <div className="section-title">
        <label>
          Filter activity by agent{' '}
          <input value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => void load()}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Re-check presence'}
        </button>
      </div>
      {error && (
        <div className="inline-warning" role="alert">
          {error}
        </div>
      )}
      {!error && agents.length === 0 && (
        <Empty
          title="No agents registered"
          body="Issue an agent credential to add the first directory entry."
        />
      )}
      {agents.length > 0 && (
        <div className="agent-directory-list">
          {agents
            .filter((agent) => !filter || agent.label.toLowerCase().includes(filter.toLowerCase()))
            .map((agent) => {
              const live = presence[agent.label.toLowerCase()];
              const current = live && !isAgentActivityStale(live.lastActivityAt) ? live : null;
              const summary = summaries[agent.label.toLowerCase()];
              return (
                <article key={agent.id} className="agent-directory-entry">
                  <div className="section-title">
                    <h3>{agent.displayName}</h3>
                    <span className={`status-pill ${(current?.state ?? 'unknown').toLowerCase()}`}>
                      {current
                        ? current.state
                        : agent.availability === 'HISTORICAL'
                          ? 'Historical availability'
                          : 'Not verified'}
                    </span>
                    {agent.availability === 'CURRENT' && (
                      <small className="muted">Verified recently</small>
                    )}
                  </div>
                  <p className="muted">
                    Live presence:{' '}
                    {current
                      ? `${current.state}${current.availability ? ` — ${current.availability}` : ''}`
                      : 'Unknown'}
                  </p>
                  <p className="muted">
                    {agent.label} ·{' '}
                    {agent.trustLevel === 'VERIFIED' ? 'Trusted profile' : 'Unverified profile'}
                  </p>
                  {agent.bio && <p>{agent.bio}</p>}
                  <div className="agent-charter">
                    <label htmlFor={`agent-charter-${agent.id}`}>
                      Charter for {agent.displayName}
                    </label>
                    <textarea
                      id={`agent-charter-${agent.id}`}
                      value={charterDrafts[agent.id] ?? agent.charter ?? ''}
                      onChange={(event) =>
                        setCharterDrafts((current) => ({
                          ...current,
                          [agent.id]: event.target.value,
                        }))
                      }
                      maxLength={AGENT_PROFILE_CHARTER_MAX}
                      rows={4}
                      placeholder="Describe this agent's standing responsibility."
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void saveCharter(agent)}
                      disabled={savingCharter === agent.id}
                    >
                      {savingCharter === agent.id ? 'Saving…' : 'Save charter'}
                    </button>
                    {charterStatus[agent.id] && (
                      <small role="status">{charterStatus[agent.id]}</small>
                    )}
                  </div>
                  {agent.charter && (
                    <details open={agent.charter.length <= 500}>
                      <summary>Published charter</summary>
                      <p>{agent.charter}</p>
                    </details>
                  )}
                  {agent.capabilities.length > 0 && (
                    <ul>
                      {agent.capabilities.map((cap) => (
                        <li key={cap.name}>
                          <strong>{cap.name}</strong>
                          {cap.description ? ` — ${cap.description}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  {summary && (
                    <div className="activity-summary">
                      <strong>Current activity</strong>
                      <p>{summary.text}</p>
                      <small>
                        Generated {new Date(summary.generatedAt).toLocaleString()} · Evidence:{' '}
                        {summary.evidence.length ? summary.evidence.join(', ') : 'None recorded'}
                      </small>
                    </div>
                  )}
                </article>
              );
            })}
        </div>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../api';
import { Empty } from './Primitives';

type Capability = { name: string; description: string | null };
type Agent = {
  id: string;
  label: string;
  displayName: string;
  bio: string | null;
  trustLevel: string;
  availability: string;
  lastVerifiedAt: string | null;
  capabilities: Capability[];
};

export function AgentDirectoryCard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<{ agents?: Agent[] }>('/agents/directory')
      .then((result) =>
        setAgents(
          Array.isArray(result.agents)
            ? result.agents
                .filter((agent): agent is Agent => Boolean(agent && typeof agent === 'object'))
                .map((agent) => ({
                  ...agent,
                  id: agent.id ?? agent.label,
                  label: agent.label ?? 'Unknown agent',
                  displayName: agent.displayName ?? agent.label ?? 'Unknown agent',
                  availability: agent.availability ?? 'UNKNOWN',
                  trustLevel: agent.trustLevel ?? 'UNVERIFIED',
                  capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
                }))
            : [],
        ),
      )
      .catch((problem) => setError((problem as Error).message));
  }, []);
  return (
    <section className="panel settings-card" aria-labelledby="agent-directory-heading">
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
          {agents.map((agent) => (
            <article key={agent.id} className="agent-directory-entry">
              <div className="section-title">
                <h3>{agent.displayName}</h3>
                <span className={`status-pill ${agent.availability.toLowerCase()}`}>
                  {agent.availability === 'CURRENT'
                    ? 'Verified recently'
                    : agent.availability === 'HISTORICAL'
                      ? 'Historical availability'
                      : 'Not verified'}
                </span>
              </div>
              <p className="muted">
                {agent.label} ·{' '}
                {agent.trustLevel === 'VERIFIED' ? 'Trusted profile' : 'Unverified profile'}
              </p>
              {agent.bio && <p>{agent.bio}</p>}
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
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

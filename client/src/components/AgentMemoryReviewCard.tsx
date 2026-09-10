import { useCallback, useEffect, useState } from 'react';
import type { AgentMemory } from '../../../shared/agent-memory';
import { api, send } from '../api';

export function AgentMemoryReviewCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [rows, setRows] = useState<AgentMemory[]>([]);
  const [state, setState] = useState('SUGGESTED');
  const [scope, setScope] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ state });
      if (scope) q.set('scope', scope);
      const result = await api<{ memories: AgentMemory[] }>(`/agent-memory?${q}`);
      setRows(Array.isArray(result.memories) ? result.memories : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load memory.');
    }
  }, [scope, state]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (id: string, action: string, method: string, body?: unknown) => {
    try {
      await send(`/agent-memory/${id}${action}`, method, body);
      flash('Memory updated.', 'success');
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Memory action failed.', 'error');
    }
  };
  return (
    <section
      className="panel settings-card"
      id="agent-memory"
      aria-labelledby="agent-memory-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">Agent context</p>
          <h2 id="agent-memory-heading">Memory review queue</h2>
        </div>
      </div>
      <p>Review what agents suggest before it becomes durable shared context.</p>
      <div className="filter-row">
        <label>
          State{' '}
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option>SUGGESTED</option>
            <option>APPROVED</option>
            <option>ARCHIVED</option>
          </select>
        </label>
        <label>
          Scope{' '}
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">All scopes</option>
            <option>workspace</option>
            <option>client</option>
            <option>project</option>
            <option>task</option>
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {!error && rows.length === 0 && <p>No memories match this filter.</p>}
      <div className="agent-memory-list">
        {rows.map((row) => (
          <article className="agent-memory-entry" key={row.id}>
            <h3>{row.key}</h3>
            <p>{row.value}</p>
            <p>
              <strong>{row.scope.type}</strong>
              {row.scope.id ? ` · ${row.scope.id}` : ''} · {row.source} · suggested by{' '}
              {row.suggestedBy}
            </p>
            <p>
              Created {new Date(row.createdAt).toLocaleString()} · expires{' '}
              {row.expiresAt ? new Date(row.expiresAt).toLocaleString() : 'never'}
            </p>
            {row.state === 'SUGGESTED' && (
              <div className="button-row">
                <button
                  className="secondary-btn"
                  onClick={() => void act(row.id, '/approve', 'POST')}
                >
                  Approve
                </button>
                <button
                  className="secondary-btn"
                  onClick={() => {
                    const value = window.prompt('Correct the memory value', row.value);
                    if (value && value !== row.value) void act(row.id, '', 'PATCH', { value });
                  }}
                >
                  Correct + approve
                </button>
              </div>
            )}
            {row.state !== 'ARCHIVED' && (
              <button
                className="secondary-btn"
                onClick={() => void act(row.id, '/archive', 'POST')}
              >
                Archive
              </button>
            )}
            <button
              className="danger-btn"
              onClick={() => {
                if (window.confirm('Delete this memory permanently?'))
                  void act(row.id, '', 'DELETE');
              }}
            >
              Delete
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Handshake, RefreshCw } from 'lucide-react';
import { api, send } from '../api';
import type { Task } from '../../../shared/types';
import {
  AGENT_COORDINATION_LIMITS,
  AGENT_IDENTITY_PROVENANCE_LABEL,
  AGENT_HANDOFF_INBOX_GROUP_LABEL,
  AGENT_HANDOFF_INBOX_GROUPS,
  AGENT_HANDOFF_SUBJECT_TYPE_LABEL,
  groupHandoffsForInbox,
  handoffMessageExcerpt,
  handoffSubjectPath,
  isStaleOpenHandoff,
  type AgentHandoff,
  type AgentHandoffDetail,
  type AgentHandoffInboxGroup,
  type AgentHandoffPage,
} from '../../../shared/agent-coordination';
import { formatDateTime } from './formatting';
import { Empty } from './Primitives';

/**
 * Operator coordination inbox (C112): list, open, and cancel agent handoffs.
 *
 * Agents post via MCP; this card never creates a handoff. Cancel is the only write, and it
 * requires a reason. Groups and staleness rules live in `shared/agent-coordination.ts` so the
 * page and the unit tests cannot drift.
 */
export function AgentHandoffsCard({
  tasks,
  flash,
}: {
  tasks: Task[];
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [handoffs, setHandoffs] = useState<AgentHandoff[]>([]);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentHandoffDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await api<AgentHandoffPage>('/agent-handoffs');
      setHandoffs(page.handoffs);
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
      setHandoffs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setCancelReason('');
    setDetailBusy(true);
    setDetailError('');
    try {
      setDetail(await api<AgentHandoffDetail>(`/agent-handoffs/${id}`));
    } catch (problem) {
      setDetail(null);
      setDetailError((problem as Error).message);
    } finally {
      setDetailBusy(false);
    }
  };

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailError('');
    setCancelReason('');
  };

  const cancel = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !cancelReason.trim()) return;
    setCancelBusy(true);
    try {
      await send(`/agent-handoffs/${selectedId}/cancel`, 'POST', { reason: cancelReason.trim() });
      flash('Handoff cancelled.');
      closeDetail();
      await load();
    } catch (problem) {
      flash((problem as Error).message, 'error');
    } finally {
      setCancelBusy(false);
    }
  };

  const groups = groupHandoffsForInbox(handoffs);
  const canCancel = detail && (detail.state === 'OPEN' || detail.state === 'CLAIMED');

  return (
    <section
      className="panel settings-card"
      id="agent-handoffs"
      aria-labelledby="agent-handoffs-heading"
    >
      <div className="settings-icon neutral">
        <Handshake />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Coordination</span>
          <h2 id="agent-handoffs-heading">Agent handoffs</h2>
        </div>
        <button
          type="button"
          className="text-btn"
          onClick={() => void load()}
          aria-label="Refresh handoffs"
        >
          <RefreshCw /> Refresh
        </button>
      </div>
      <p>
        What agents asked each other to do. Agents post through MCP; cancel a stuck handoff here
        with a required reason. Completed and cancelled rows show the last seven days.
      </p>

      {error && (
        <div className="inline-warning" role="alert">
          <AlertCircle />
          <div>
            <strong>Handoffs unavailable</strong>
            <span>{error}</span>
          </div>
        </div>
      )}

      {!error &&
        AGENT_HANDOFF_INBOX_GROUPS.map((group) => (
          <HandoffGroup
            key={group}
            group={group}
            rows={groups[group]}
            tasks={tasks}
            selectedId={selectedId}
            onOpen={(id) => void openDetail(id)}
          />
        ))}

      {selectedId && (
        <div className="handoff-detail" role="region" aria-label="Handoff detail">
          {detailBusy && <p className="muted">Loading handoff…</p>}
          {detailError && (
            <div className="inline-warning" role="alert">
              <AlertCircle />
              <div>
                <strong>Could not open handoff</strong>
                <span>{detailError}</span>
              </div>
            </div>
          )}
          {detail && !detailBusy && (
            <>
              <div className="handoff-detail-head">
                <div>
                  <span className="handoff-state">{detail.state}</span>
                  <p className="handoff-route">
                    <strong>{detail.fromAgentLabel}</strong>
                    <IdentityProvenance provenance={detail.fromAgentProvenance} />
                    <ArrowRight aria-hidden="true" />
                    <strong>{detail.toAgentLabel ?? 'any agent'}</strong>
                  </p>
                </div>
                <button type="button" className="text-btn" onClick={closeDetail}>
                  Close
                </button>
              </div>
              {isStaleOpenHandoff(detail) && (
                <div className="inline-warning attention" role="status">
                  <AlertCircle />
                  <div>
                    <strong>Open longer than 30 days</strong>
                    <span>Still waiting for a claim — cancel if it is no longer needed.</span>
                  </div>
                </div>
              )}
              <p className="handoff-message">{detail.message}</p>
              <SubjectLine handoff={detail} tasks={tasks} />
              {detail.sourceConversationId && (
                <p>
                  Originating thread:{' '}
                  <Link
                    to={`/agents/conversations?open=${encodeURIComponent(detail.sourceConversationId)}`}
                  >
                    Open conversation
                  </Link>
                </p>
              )}
              <dl className="handoff-meta">
                <div>
                  <dt>Created</dt>
                  <dd>{formatDateTime(detail.createdAt)}</dd>
                </div>
                {detail.claimedBy && (
                  <div>
                    <dt>Claimed by</dt>
                    <dd>
                      {detail.claimedBy}
                      {' · '}
                      {detail.claimedByProvenance
                        ? AGENT_IDENTITY_PROVENANCE_LABEL[detail.claimedByProvenance]
                        : AGENT_IDENTITY_PROVENANCE_LABEL.UNKNOWN}
                      {detail.claimedAt ? ` · ${formatDateTime(detail.claimedAt)}` : ''}
                    </dd>
                  </div>
                )}
                {detail.completedAt && (
                  <div>
                    <dt>Completed</dt>
                    <dd>
                      {formatDateTime(detail.completedAt)} ·{' '}
                      {detail.completedByProvenance
                        ? AGENT_IDENTITY_PROVENANCE_LABEL[detail.completedByProvenance]
                        : AGENT_IDENTITY_PROVENANCE_LABEL.UNKNOWN}
                    </dd>
                  </div>
                )}
                {detail.cancelledAt && (
                  <div>
                    <dt>Cancelled</dt>
                    <dd>
                      {formatDateTime(detail.cancelledAt)}
                      {detail.cancelReason ? ` — ${detail.cancelReason}` : ''}
                    </dd>
                  </div>
                )}
                {detail.state === 'COMPLETED' && (
                  <div>
                    <dt>Outcome</dt>
                    <dd>{detail.outcome ?? 'Legacy completion — no outcome recorded'}</dd>
                  </div>
                )}
              </dl>

              {detail.resultSummary && (
                <div className="handoff-evidence">
                  <h3>Completion evidence</h3>
                  <p>{detail.resultSummary}</p>
                  {detail.changedPaths?.length ? (
                    <p>
                      <strong>Changed paths:</strong> {detail.changedPaths.join(', ')}
                    </p>
                  ) : null}
                  {detail.references?.length ? (
                    <p>
                      <strong>References:</strong> {detail.references.join(', ')}
                    </p>
                  ) : null}
                  {detail.validations?.length ? (
                    <ul>
                      {detail.validations.map((item, index) => (
                        <li key={`${item.command}-${index}`}>
                          <code>{item.command}</code> — {item.outcome}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {detail.remainingRisks?.length ? (
                    <p>
                      <strong>Remaining risks:</strong> {detail.remainingRisks.join('; ')}
                    </p>
                  ) : null}
                </div>
              )}

              <h3 className="handoff-notes-title">Notes</h3>
              {detail.notes.length === 0 ? (
                <p className="muted">No notes on this handoff.</p>
              ) : (
                <ul className="handoff-notes">
                  {detail.notes.map((note) => (
                    <li key={note.id}>
                      <strong>{note.agentLabel}</strong>
                      <IdentityProvenance provenance={note.agentProvenance} />
                      <span>{formatDateTime(note.at)}</span>
                      <p>{note.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              {canCancel && (
                <form className="handoff-cancel" onSubmit={cancel}>
                  <label>
                    Cancel reason
                    <textarea
                      value={cancelReason}
                      onChange={(event) => setCancelReason(event.target.value)}
                      maxLength={AGENT_COORDINATION_LIMITS.cancelReason}
                      rows={3}
                      required
                      placeholder="Why is this handoff being cancelled?"
                    />
                  </label>
                  <button
                    type="submit"
                    className="danger-outline"
                    disabled={cancelBusy || !cancelReason.trim()}
                  >
                    {cancelBusy ? 'Cancelling…' : 'Cancel handoff'}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function HandoffGroup({
  group,
  rows,
  tasks,
  selectedId,
  onOpen,
}: {
  group: AgentHandoffInboxGroup;
  rows: AgentHandoff[];
  tasks: Task[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const label = AGENT_HANDOFF_INBOX_GROUP_LABEL[group];
  return (
    <div className="handoff-group" aria-labelledby={`handoff-group-${group}`}>
      <h3 id={`handoff-group-${group}`} className="handoff-group-title">
        {label}
        <span className="handoff-count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <Empty
          compact
          title={`No ${label.toLowerCase()} handoffs`}
          body={
            group === 'open' || group === 'claimed'
              ? 'Nothing waiting here.'
              : 'Nothing in the last seven days.'
          }
        />
      ) : (
        <ul className="handoff-list">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`handoff-row ${selectedId === row.id ? 'is-selected' : ''}`}
                onClick={() => onOpen(row.id)}
                aria-expanded={selectedId === row.id}
              >
                <span className="handoff-route">
                  <strong>{row.fromAgentLabel}</strong>
                  <IdentityProvenance provenance={row.fromAgentProvenance} />
                  <ArrowRight aria-hidden="true" />
                  <span>{row.toAgentLabel ?? 'any agent'}</span>
                </span>
                <span className="handoff-excerpt">{handoffMessageExcerpt(row.message)}</span>
                {row.state === 'COMPLETED' && (
                  <span className="handoff-outcome">{row.outcome ?? 'Legacy completion'}</span>
                )}
                <span className="handoff-row-meta">
                  <SubjectLine handoff={row} tasks={tasks} inline />
                  {row.claimedBy && <span>Claimed by {row.claimedBy}</span>}
                  <span>{formatDateTime(row.createdAt)}</span>
                  {isStaleOpenHandoff(row) && (
                    <span className="handoff-stale">Open longer than 30 days</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IdentityProvenance({ provenance }: { provenance: AgentHandoff['fromAgentProvenance'] }) {
  return (
    <span className="handoff-identity-provenance">
      {AGENT_IDENTITY_PROVENANCE_LABEL[provenance]}
    </span>
  );
}

function SubjectLine({
  handoff,
  tasks,
  inline,
}: {
  handoff: Pick<AgentHandoff, 'subjectType' | 'subjectId'>;
  tasks: Task[];
  inline?: boolean;
}) {
  const label = AGENT_HANDOFF_SUBJECT_TYPE_LABEL[handoff.subjectType];
  const path = handoffSubjectPath(handoff, tasks);
  if (!handoff.subjectId && handoff.subjectType === 'freeform') {
    return inline ? null : <p className="muted">No bound subject.</p>;
  }
  const text = handoff.subjectId ? `${label}: ${handoff.subjectId}` : label;
  if (path) {
    return (
      <span className={inline ? 'handoff-subject' : 'handoff-subject-block'}>
        {inline ? (
          <Link to={path} onClick={(event) => event.stopPropagation()}>
            {text}
          </Link>
        ) : (
          <p>
            Subject: <Link to={path}>{text}</Link>
          </p>
        )}
      </span>
    );
  }
  return inline ? (
    <span className="handoff-subject">{text}</span>
  ) : (
    <p className="handoff-subject-block">Subject: {text}</p>
  );
}

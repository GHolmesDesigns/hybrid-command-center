import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, CheckCircle2, Handshake, MessageSquare, Send } from 'lucide-react';
import type { AgentHandoff, AgentHandoffPage } from '../../../shared/agent-coordination';
import { AGENT_HANDOFF_SUBJECT_TYPE_LABEL } from '../../../shared/agent-coordination';
import type { MessageLinkedHandoff } from '../../../shared/agent-conversations';
import { api, send } from '../api';
import { formatDateTime } from './formatting';
import { MentionHandoffPreview, MessageLinkedHandoffs } from './MentionHandoffCompose';
import { useMentionHandoffCompose } from './useMentionHandoffCompose';

type ScopeType = 'client' | 'project' | 'task';
type Conversation = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  state: 'ACTIVE' | 'ARCHIVED';
  isDecision: boolean;
  decisionOutcome: string | null;
};
type Message = {
  id: string;
  senderLabel: string;
  sentAt: string;
  body: string;
  linkedHandoffs?: MessageLinkedHandoff[];
};
type AgentDirectoryEntry = { label: string };
type Page<T> = { items: T[]; nextCursor: string | null };

const RELATED_HANDOFF_LIMIT = 20;

export function DiscussionPanel({
  scopeType,
  scopeId,
  subjectLabel,
  subjectPath,
}: {
  scopeType: ScopeType;
  scopeId: string;
  subjectLabel: string;
  subjectPath: string;
}) {
  const headingId = useId();
  const handoffHeadingId = useId();
  const loadSequence = useRef(0);
  const [items, setItems] = useState<Conversation[]>([]);
  const [handoffs, setHandoffs] = useState<AgentHandoff[]>([]);
  const [handoffsTruncated, setHandoffsTruncated] = useState(false);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [conversationError, setConversationError] = useState('');
  const [handoffError, setHandoffError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<'start' | 'reply' | null>(null);
  const [registeredLabels, setRegisteredLabels] = useState<string[]>([]);
  const { offered, confirmed, toggle } = useMentionHandoffCompose(body, registeredLabels);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    const scopeQuery = `subjectType=${scopeType}&subjectId=${encodeURIComponent(scopeId)}`;
    const [conversationResult, handoffResult] = await Promise.allSettled([
      api<Page<Conversation>>(
        `/agent-conversations?state=ACTIVE&scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}`,
      ),
      api<AgentHandoffPage>(`/agent-handoffs?${scopeQuery}&limit=${RELATED_HANDOFF_LIMIT}`),
    ]);
    if (sequence !== loadSequence.current) return;

    if (conversationResult.status === 'fulfilled') {
      setItems(conversationResult.value.items ?? []);
      setConversationError('');
    } else {
      setConversationError((conversationResult.reason as Error).message);
    }
    if (handoffResult.status === 'fulfilled') {
      setHandoffs(handoffResult.value.handoffs ?? []);
      setHandoffsTruncated(handoffResult.value.truncated);
      setHandoffError('');
    } else {
      setHandoffError((handoffResult.reason as Error).message);
    }
    setLoading(false);
  }, [scopeType, scopeId]);

  useEffect(() => {
    setItems([]);
    setHandoffs([]);
    setSelected(null);
    setMessages([]);
    setBody('');
    setTitle('');
    setConversationError('');
    setHandoffError('');
    setActionError('');
    void load();
    void api<{ agents: AgentDirectoryEntry[] }>('/agents/directory')
      .then((page) => setRegisteredLabels((page.agents ?? []).map((entry) => entry.label)))
      .catch(() => setRegisteredLabels([]));
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  const open = async (conversation: Conversation) => {
    setSelected(conversation);
    setMessages([]);
    setActionError('');
    try {
      const page = await api<Page<Message>>(
        `/agent-conversations/${conversation.id}/messages?limit=20&direction=before`,
      );
      setMessages(page.items);
    } catch (problem) {
      setActionError((problem as Error).message);
    }
  };

  const start = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || busy) return;
    setBusy('start');
    setActionError('');
    try {
      const created = await send<Conversation>('/agent-conversations', 'POST', {
        title: trimmedTitle,
        scope: { type: scopeType, id: scopeId },
      });
      setTitle('');
      await load();
      await open(created);
    } catch (problem) {
      setActionError((problem as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const post = async () => {
    const trimmedBody = body.trim();
    if (!selected || !trimmedBody || busy) return;
    setBusy('reply');
    setActionError('');
    try {
      const message = await send<Message>(`/agent-conversations/${selected.id}/messages`, 'POST', {
        body: trimmedBody,
        confirmHandoffs: confirmed,
        clientRequestId: crypto.randomUUID(),
      });
      setMessages((current) => [...current, message]);
      setBody('');
      await load();
    } catch (problem) {
      setActionError((problem as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const scopedConversationPath = `/agents/conversations?scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}`;
  const subjectTypeLabel = AGENT_HANDOFF_SUBJECT_TYPE_LABEL[scopeType];

  return (
    <section className="panel discussion-panel" aria-labelledby={headingId}>
      <div className="section-title">
        <div>
          <span className="eyebrow">Discussion</span>
          <h2 id={headingId}>
            <MessageSquare /> Threads
          </h2>
        </div>
        <Link className="buttonlike secondary" to={scopedConversationPath}>
          Open all
        </Link>
      </div>

      {conversationError && (
        <div className="inline-warning" role="alert">
          <AlertCircle />
          <div>
            <strong>Discussion unavailable</strong>
            <span>{conversationError}</span>
          </div>
        </div>
      )}
      {loading && items.length === 0 && !conversationError && (
        <p className="muted">Loading discussion…</p>
      )}
      {!loading && items.length === 0 && !selected && !conversationError && (
        <p className="empty">No discussion yet. Start a thread for this {scopeType}.</p>
      )}

      <div className="discussion-thread-list">
        {items.map((item) => (
          <button
            type="button"
            className={`list-row ${selected?.id === item.id ? 'selected' : ''}`}
            key={item.id}
            onClick={() => void open(item)}
          >
            <strong>
              {item.title}{' '}
              {item.isDecision && (
                <span className="decision-badge">
                  <CheckCircle2 aria-hidden="true" /> Decision
                  {item.decisionOutcome ? `: ${item.decisionOutcome}` : ''}
                </span>
              )}
            </strong>
            <span>
              {item.messageCount} messages · {formatDateTime(item.updatedAt)}
            </span>
          </button>
        ))}
      </div>

      {!selected && !conversationError && (
        <form
          className="discussion-start"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <label>
            Thread title
            <input
              placeholder={`Start a thread about ${subjectLabel}`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
            />
          </label>
          <span className="field-hint">
            Scope: <Link to={subjectPath}>{subjectLabel}</Link> ({subjectTypeLabel}, locked)
          </span>
          <button type="submit" disabled={busy !== null || !title.trim()}>
            <MessageSquare /> {busy === 'start' ? 'Starting…' : 'Start thread'}
          </button>
        </form>
      )}

      {selected && (
        <div className="discussion-detail">
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              setSelected(null);
              setMessages([]);
              setActionError('');
            }}
          >
            <ArrowLeft /> Back to threads
          </button>
          <h3>{selected.title}</h3>
          {messages.length === 0 && !actionError && <p className="muted">No messages yet.</p>}
          {messages.map((message) => (
            <article className="conversation-message" key={message.id}>
              <strong>{message.senderLabel}</strong>
              <time>{formatDateTime(message.sentAt)}</time>
              <p>{message.body}</p>
              <MessageLinkedHandoffs handoffs={message.linkedHandoffs ?? []} />
            </article>
          ))}
          <form
            className="conversation-compose"
            onSubmit={(event) => {
              event.preventDefault();
              void post();
            }}
          >
            <label>
              Reply
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write a reply (@agent to open a handoff)"
                maxLength={4000}
                required
              />
            </label>
            <MentionHandoffPreview offered={offered} confirmed={confirmed} onToggle={toggle} />
            <button type="submit" disabled={busy !== null || !body.trim()}>
              <Send /> {busy === 'reply' ? 'Replying…' : 'Reply'}
            </button>
          </form>
        </div>
      )}

      {actionError && (
        <div className="inline-warning" role="alert">
          <AlertCircle />
          <div>
            <strong>Discussion action failed</strong>
            <span>{actionError}</span>
          </div>
        </div>
      )}

      <section className="discussion-handoffs" aria-labelledby={handoffHeadingId}>
        <div className="card-head">
          <h3 id={handoffHeadingId}>
            <Handshake /> Related handoffs
          </h3>
          <Link className="text-btn" to="/settings#agent-handoffs">
            Open coordination inbox
          </Link>
        </div>
        {handoffError && (
          <div className="inline-warning" role="alert">
            <AlertCircle />
            <div>
              <strong>Related handoffs unavailable</strong>
              <span>{handoffError}</span>
            </div>
          </div>
        )}
        {!loading && !handoffError && handoffs.length === 0 && (
          <p className="muted">No handoffs are bound to this {scopeType}.</p>
        )}
        {handoffs.length > 0 && (
          <ul className="discussion-handoff-list">
            {handoffs.map((handoff) => (
              <li key={handoff.id}>
                <span className="handoff-state">{handoff.state}</span>
                <strong>{subjectTypeLabel} handoff</strong>
                <p>{handoff.message}</p>
                <small>
                  {handoff.fromAgentLabel} → {handoff.toAgentLabel ?? 'any agent'} ·{' '}
                  {formatDateTime(handoff.updatedAt)}
                  {handoff.sourceConversationId && (
                    <>
                      {' '}
                      ·{' '}
                      <Link
                        to={`/agents/conversations?open=${encodeURIComponent(handoff.sourceConversationId)}`}
                      >
                        From thread
                      </Link>
                    </>
                  )}
                </small>
              </li>
            ))}
          </ul>
        )}
        {handoffsTruncated && (
          <p className="field-hint">
            More related handoffs are available in the coordination inbox.
          </p>
        )}
      </section>
    </section>
  );
}

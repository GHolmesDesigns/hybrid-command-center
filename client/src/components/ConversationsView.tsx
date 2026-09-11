import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, ArrowDown, CheckCircle2, MessageSquare, Send } from 'lucide-react';
import type { MessageLinkedHandoff } from '../../../shared/agent-conversations';
import { api, send } from '../api';
import { PageHead } from './Shell';
import { MentionHandoffPreview, MessageLinkedHandoffs } from './MentionHandoffCompose';
import { useMentionHandoffCompose } from './useMentionHandoffCompose';

type Conversation = {
  id: string;
  title: string;
  state: 'ACTIVE' | 'ARCHIVED';
  scope: { type: 'client' | 'project' | 'task' | 'freeform'; id: string | null };
  participants: string[];
  messageCount: number;
  updatedAt: string;
  isDecision: boolean;
  decisionOutcome: string | null;
  decidedAt: string | null;
};
type Message = {
  id: string;
  senderLabel: string;
  sentAt: string;
  body: string;
  provenance: 'UNKNOWN' | 'ASSERTED' | 'VERIFIED';
  linkedHandoffs?: MessageLinkedHandoff[];
};
type AgentDirectoryEntry = { label: string };
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
type ConversationFilter = 'ACTIVE' | 'ARCHIVED' | 'DECISIONS';

const SCOPE_LABEL = {
  client: 'Client',
  project: 'Project',
  task: 'Task',
  freeform: 'Freeform',
} as const;

const scopePath = (scope: Conversation['scope']): string | null => {
  if (!scope.id || scope.type === 'freeform') return null;
  return `/${scope.type === 'task' ? 'tasks' : `${scope.type}s`}/${encodeURIComponent(scope.id)}`;
};

export function ConversationsView({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [searchParams] = useSearchParams();
  const requestedScopeType = searchParams.get('scopeType');
  const scopeType =
    requestedScopeType === 'client' ||
    requestedScopeType === 'project' ||
    requestedScopeType === 'task'
      ? requestedScopeType
      : null;
  const scopeId = scopeType ? searchParams.get('scopeId')?.trim() || null : null;
  const openConversationId = searchParams.get('open')?.trim() || null;
  const scopeQuery =
    scopeType && scopeId ? `&scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}` : '';
  const [filter, setFilter] = useState<ConversationFilter>('ACTIVE');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [decisionOutcome, setDecisionOutcome] = useState('');
  const [registeredLabels, setRegisteredLabels] = useState<string[]>([]);
  const { offered, confirmed, toggle } = useMentionHandoffCompose(body, registeredLabels);
  const load = useCallback(async () => {
    try {
      const page = await api<Page<Conversation>>(
        `/agent-conversations?${filter === 'DECISIONS' ? 'isDecision=true' : `state=${filter}`}${scopeQuery}`,
      );
      setConversations(page.items);
      setSelected((current) =>
        current ? (page.items.find((item) => item.id === current.id) ?? null) : null,
      );
    } catch (error) {
      flash((error as Error).message, 'error');
    }
  }, [filter, flash, scopeQuery]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<{ agents: AgentDirectoryEntry[] }>('/agents/directory')
      .then((page) => setRegisteredLabels((page.agents ?? []).map((entry) => entry.label)))
      .catch(() => setRegisteredLabels([]));
  }, []);
  const openedConversationRef = useRef<string | null>(null);
  const open = useCallback(async (conversation: Conversation) => {
    setSelected(conversation);
    setDecisionOutcome(conversation.decisionOutcome ?? '');
    const page = await api<Page<Message>>(
      `/agent-conversations/${conversation.id}/messages?limit=50&direction=before`,
    );
    setMessages(page.items);
    setOlder(page.nextCursor);
  }, []);
  const saveDecision = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    try {
      const updated = await send<Conversation>(
        `/agent-conversations/${selected.id}/decision`,
        'POST',
        { outcome: decisionOutcome },
      );
      setSelected(updated);
      setDecisionOutcome(updated.decisionOutcome ?? '');
      await load();
      flash('Decision saved.', 'success');
    } catch (error) {
      flash((error as Error).message, 'error');
    }
  };
  const clearDecision = async () => {
    if (!selected || !window.confirm('Clear the decision mark from this conversation?')) return;
    try {
      const updated = await send<Conversation>(
        `/agent-conversations/${selected.id}/decision/clear`,
        'POST',
      );
      setSelected(updated);
      setDecisionOutcome('');
      await load();
      flash('Decision mark cleared.', 'success');
    } catch (error) {
      flash((error as Error).message, 'error');
    }
  };
  useEffect(() => {
    if (!openConversationId || conversations.length === 0) return;
    if (openedConversationRef.current === openConversationId) return;
    const conversation = conversations.find((entry) => entry.id === openConversationId);
    if (conversation) {
      openedConversationRef.current = openConversationId;
      void open(conversation);
    }
  }, [openConversationId, conversations, open]);
  const post = async () => {
    if (!selected || !body.trim()) return;
    const message = await send<Message>(`/agent-conversations/${selected.id}/messages`, 'POST', {
      body,
      confirmHandoffs: confirmed,
      clientRequestId: crypto.randomUUID(),
    });
    setMessages((current) => [...current, message]);
    setBody('');
    await load();
  };
  const archive = async () => {
    if (!selected) return;
    if (!window.confirm('Archive this conversation?')) return;
    await send(`/agent-conversations/${selected.id}/archive`, 'POST');
    setSelected(null);
    await load();
  };
  const loadOlder = async () => {
    if (!selected || !older) return;
    const page = await api<Page<Message>>(
      `/agent-conversations/${selected.id}/messages?limit=50&direction=before&cursor=${encodeURIComponent(older)}`,
    );
    setMessages((current) => [...page.items, ...current]);
    setOlder(page.nextCursor);
  };
  return (
    <div className="page">
      <PageHead
        eyebrow="Agents"
        title="Conversations"
        body="Review and respond to agent threads with frozen message provenance."
      />
      {scopeType && scopeId && (
        <p className="field-hint">
          Showing {scopeType} discussion for <code>{scopeId}</code>.{' '}
          <Link to="/agents/conversations">Show every conversation</Link>
        </p>
      )}
      <div className="split-layout">
        <section className="card" aria-label="Conversation list">
          <div className="card-head">
            <h2>
              <MessageSquare /> Threads
            </h2>
            <select
              aria-label="Conversation state"
              value={filter}
              onChange={(event) => setFilter(event.target.value as ConversationFilter)}
            >
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
              <option value="DECISIONS">Decisions</option>
            </select>
          </div>
          {conversations.length === 0 && <p className="empty">No conversations.</p>}
          {conversations.map((conversation) => {
            const subjectPath = scopePath(conversation.scope);
            return (
              <div
                className={`list-row conversation-row ${selected?.id === conversation.id ? 'selected' : ''}`}
                key={conversation.id}
              >
                <button
                  type="button"
                  className="conversation-open"
                  onClick={() => void open(conversation)}
                >
                  <strong>
                    {conversation.title}{' '}
                    {conversation.isDecision && (
                      <span className="decision-badge">
                        <CheckCircle2 aria-hidden="true" /> Decision
                        {conversation.decisionOutcome ? `: ${conversation.decisionOutcome}` : ''}
                      </span>
                    )}
                  </strong>
                  <span>
                    {conversation.scope.type} · {conversation.messageCount} messages
                  </span>
                  <small>{conversation.participants.join(', ')}</small>
                </button>
                {subjectPath && (
                  <Link className="conversation-subject-link" to={subjectPath}>
                    {SCOPE_LABEL[conversation.scope.type]}: {conversation.scope.id}
                  </Link>
                )}
              </div>
            );
          })}
        </section>
        {selected && (
          <section className="card" aria-label="Conversation detail">
            <div className="card-head">
              <div>
                <h2>{selected.title}</h2>
                <p>
                  {scopePath(selected.scope) ? (
                    <Link to={scopePath(selected.scope)!}>
                      {SCOPE_LABEL[selected.scope.type]}: {selected.scope.id}
                    </Link>
                  ) : (
                    selected.scope.type
                  )}{' '}
                  · {selected.participants.join(', ')}
                </p>
              </div>
              {selected.state === 'ACTIVE' && (
                <button className="secondary-btn" onClick={() => void archive()}>
                  <Archive /> Archive
                </button>
              )}
            </div>
            <form className="conversation-decision" onSubmit={(event) => void saveDecision(event)}>
              {selected.isDecision && (
                <p className="decision-summary">
                  <span className="decision-badge">
                    <CheckCircle2 aria-hidden="true" /> Decision
                  </span>{' '}
                  Outcome: {selected.decisionOutcome || 'No outcome recorded.'}
                </p>
              )}
              <label>
                Decision outcome <span className="field-hint">(optional)</span>
                <textarea
                  aria-label="Decision outcome"
                  value={decisionOutcome}
                  onChange={(event) => setDecisionOutcome(event.target.value)}
                  maxLength={500}
                  placeholder="What was decided?"
                />
              </label>
              <div className="conversation-decision-actions">
                <button className="secondary-btn" type="submit">
                  <CheckCircle2 aria-hidden="true" />
                  {selected.isDecision ? 'Save outcome' : 'Mark as decision'}
                </button>
                {selected.isDecision && (
                  <button className="text-btn" type="button" onClick={() => void clearDecision()}>
                    Clear decision mark
                  </button>
                )}
              </div>
            </form>
            <div className="conversation-messages">
              {older && (
                <button className="secondary-btn" onClick={() => void loadOlder()}>
                  <ArrowDown /> Load older
                </button>
              )}
              {messages.map((message) => (
                <article className="conversation-message" key={message.id}>
                  <div>
                    <strong>{message.senderLabel}</strong>
                    <span className={`provenance ${message.provenance.toLowerCase()}`}>
                      {message.provenance}
                    </span>
                    <time>{new Date(message.sentAt).toLocaleString()}</time>
                  </div>
                  <p>{message.body}</p>
                  <MessageLinkedHandoffs handoffs={message.linkedHandoffs ?? []} />
                </article>
              ))}
            </div>
            {selected.state === 'ACTIVE' && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void post();
                }}
                className="conversation-compose"
              >
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  maxLength={4000}
                  placeholder="Write an operator reply (@agent to open a handoff)"
                  aria-label="Message"
                />
                <MentionHandoffPreview offered={offered} confirmed={confirmed} onToggle={toggle} />
                <button className="primary-btn" type="submit">
                  <Send /> Send
                </button>
              </form>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

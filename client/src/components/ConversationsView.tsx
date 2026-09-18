import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentHubTipPayload } from '../../../shared/agent-hub-tips';
import { useAgentHubTipsSubscribe } from './AgentHubTipsContext';
import { useDebouncedAgentHubTip } from '../useAgentHubTips';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, ArrowDown, CheckCircle2, MessageSquare, Send } from 'lucide-react';
import type { MessageLinkedHandoff } from '../../../shared/agent-conversations';
import { api, send } from '../api';
import { useConversationSelection } from '../useConversationSelection';
import { fullViewSelectionIssueMessage } from './conversationSelectionUi';
import { PageHead } from './Shell';
import { MentionHandoffPreview } from './MentionHandoffCompose';
import { useMentionHandoffCompose } from './useMentionHandoffCompose';
import { ConversationTurn } from './ConversationTurn';
import type { AgentBadgePresence, AgentBadgeProfile } from './AgentBadge';

type Conversation = {
  id: string;
  title: string;
  state: 'ACTIVE' | 'ARCHIVED';
  scope: { type: 'client' | 'project' | 'task' | 'freeform'; id: string | null };
  isCanonical: boolean;
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
  thoughtSummary?: string | null;
  provenance: 'UNKNOWN' | 'ASSERTED' | 'VERIFIED';
  linkedHandoffs?: MessageLinkedHandoff[];
};
type AgentDirectoryEntry = { label: string; displayName?: string; trustLevel?: string };
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
  liveTipsEnabled = false,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
  liveTipsEnabled?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const {
    conversationId: openConversationId,
    fullViewIssue,
    applySelection,
    registerHint,
    clearSelection,
  } = useConversationSelection();
  const requestedScopeType = searchParams.get('scopeType');
  const scopeType =
    requestedScopeType === 'client' ||
    requestedScopeType === 'project' ||
    requestedScopeType === 'task'
      ? requestedScopeType
      : null;
  const scopeId = scopeType ? searchParams.get('scopeId')?.trim() || null : null;
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
  const [agentProfiles, setAgentProfiles] = useState<Record<string, AgentBadgeProfile>>({});
  const [presenceByLabel, setPresenceByLabel] = useState<Record<string, AgentBadgePresence>>({});
  const [summariesByLabel, setSummariesByLabel] = useState<Record<string, string>>({});
  const { offered, confirmed, toggle } = useMentionHandoffCompose(body, registeredLabels);
  const load = useCallback(async () => {
    try {
      const page = await api<Page<Conversation>>(
        `/agent-conversations?${filter === 'DECISIONS' ? 'isDecision=true' : `state=${filter}`}${scopeQuery}`,
      );
      setConversations(page.items);
      for (const item of page.items) {
        registerHint(item.id, {
          scopeType: item.scope.type,
          scopeId: item.scope.id,
          state: item.state,
        });
      }
      setSelected((current) =>
        current ? (page.items.find((item) => item.id === current.id) ?? null) : null,
      );
    } catch (error) {
      flash((error as Error).message, 'error');
    }
  }, [filter, flash, registerHint, scopeQuery]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void Promise.all([
      api<{ agents: AgentDirectoryEntry[] }>('/agents/directory'),
      api<{
        presence?: Array<{ agentLabel: string; state: string; lastActivityAt: string | null }>;
      }>('/agents/presence'),
      api<{ summaries?: Array<{ agentLabel: string; text: string }> }>('/agent-summaries'),
    ])
      .then(([directory, live, summaries]) => {
        const agents = directory.agents ?? [];
        setRegisteredLabels(agents.map((entry) => entry.label));
        setAgentProfiles(
          Object.fromEntries(
            agents.map((entry) => [
              entry.label.toLowerCase(),
              {
                label: entry.label,
                displayName: entry.displayName ?? entry.label,
                trustLevel: entry.trustLevel ?? 'UNVERIFIED',
              },
            ]),
          ),
        );
        setPresenceByLabel(
          Object.fromEntries(
            (live.presence ?? []).map((row) => [
              row.agentLabel.toLowerCase(),
              { state: row.state, lastActivityAt: row.lastActivityAt },
            ]),
          ),
        );
        setSummariesByLabel(
          Object.fromEntries(
            (summaries.summaries ?? []).map((row) => [row.agentLabel.toLowerCase(), row.text]),
          ),
        );
      })
      .catch(() => {
        setRegisteredLabels([]);
        setAgentProfiles({});
      });
  }, []);
  const openedConversationRef = useRef<string | null>(null);
  const open = useCallback(
    async (conversation: Conversation) => {
      registerHint(conversation.id, {
        scopeType: conversation.scope.type,
        scopeId: conversation.scope.id,
        state: conversation.state,
      });
      setSelected(conversation);
      setDecisionOutcome(conversation.decisionOutcome ?? '');
      const page = await api<Page<Message>>(
        `/agent-conversations/${conversation.id}/messages?limit=50&direction=before`,
      );
      setMessages(page.items);
      setOlder(page.nextCursor);
    },
    [registerHint],
  );
  const selectedRef = useRef<Conversation | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const subscribeAgentHubTips = useAgentHubTipsSubscribe();
  const handleConversationTip = useCallback(
    (tip: AgentHubTipPayload) => {
      void load();
      const current = selectedRef.current;
      if (!current) return;
      if (tip.conversationId && tip.conversationId !== current.id) return;
      void open(current);
    },
    [load, open],
  );
  useDebouncedAgentHubTip(
    liveTipsEnabled ? subscribeAgentHubTips : null,
    'conversations',
    handleConversationTip,
  );
  const handleCoordinationTip = useCallback(() => {
    const current = selectedRef.current;
    if (!current) return;
    void open(current);
  }, [open]);
  useDebouncedAgentHubTip(
    liveTipsEnabled ? subscribeAgentHubTips : null,
    'coordination',
    handleCoordinationTip,
  );
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
    if (!openConversationId) {
      openedConversationRef.current = null;
      return;
    }
    if (fullViewIssue === 'missing') {
      openedConversationRef.current = openConversationId;
      setSelected(null);
      setMessages([]);
      return;
    }
    if (conversations.length === 0) return;
    if (
      openedConversationRef.current === openConversationId &&
      selected?.id === openConversationId
    ) {
      return;
    }
    const conversation = conversations.find((entry) => entry.id === openConversationId);
    if (conversation) {
      openedConversationRef.current = openConversationId;
      void open(conversation);
      return;
    }
    registerHint(openConversationId, null);
  }, [openConversationId, conversations, fullViewIssue, open, registerHint, selected?.id]);
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
  const createScopedThread = async () => {
    if (!scopeType || !scopeId) return;
    try {
      const created = await send<Conversation>('/agent-conversations', 'POST', {
        title: `${scopeType} thread`,
        scope: { type: scopeType, id: scopeId },
        secondary: true,
      });
      applySelection(created.id, 'full-view', {
        scopeType: created.scope.type,
        scopeId: created.scope.id,
        state: created.state,
      });
      await load();
      flash('Secondary thread created.', 'success');
    } catch (error) {
      flash((error as Error).message, 'error');
    }
  };
  const archive = async () => {
    if (!selected) return;
    if (!window.confirm('Archive this conversation?')) return;
    await send(`/agent-conversations/${selected.id}/archive`, 'POST');
    clearSelection('full-view');
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
        body="One conversation at a time across this page and the Command AI drawer for every scope."
      />
      <p className="field-hint">
        The Command AI drawer and this page are synchronized views, not two separate clients.
        Selecting any active thread here updates the drawer when it is open, and vice versa.{' '}
        <strong>Open full view</strong> in the drawer lands on the same thread. Scoped subjects keep
        one canonical thread; additional threads are labelled Secondary thread. Posting as an agent
        via MCP is chat — it does not open a handoff. @mentions open handoffs only after you check
        them in the confirm preview.
      </p>
      {scopeType && scopeId && (
        <p className="field-hint">
          Showing {scopeType} discussion for <code>{scopeId}</code>.{' '}
          <button type="button" className="text-btn" onClick={() => void createScopedThread()}>
            New thread
          </button>{' '}
          · <Link to="/agents/conversations">Show every conversation</Link>
        </p>
      )}
      <div className="split-layout">
        <section className="card conversation-list-card" aria-label="Conversation list">
          <div className="card-head conversation-list-head">
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
                  onClick={() => {
                    applySelection(conversation.id, 'full-view', {
                      scopeType: conversation.scope.type,
                      scopeId: conversation.scope.id,
                      state: conversation.state,
                    });
                  }}
                >
                  <strong>
                    {conversation.title}{' '}
                    {conversation.scope.type !== 'freeform' && !conversation.isCanonical && (
                      <span className="secondary-thread-badge">Secondary thread</span>
                    )}
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
        {fullViewIssue === 'missing' && openConversationId && !selected && (
          <section
            className="card conversation-detail-card conversation-selection-issue"
            aria-label="Conversation unavailable"
          >
            <p>{fullViewSelectionIssueMessage('missing')}</p>
          </section>
        )}
        {selected && (
          <section className="card conversation-detail-card" aria-label="Conversation detail">
            <div className="card-head conversation-detail-head">
              <div>
                <h2>
                  {selected.title}{' '}
                  {selected.scope.type !== 'freeform' && !selected.isCanonical && (
                    <span className="secondary-thread-badge">Secondary thread</span>
                  )}
                </h2>
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
                <ConversationTurn
                  key={message.id}
                  message={message}
                  agentProfiles={agentProfiles}
                  presenceByLabel={presenceByLabel}
                  fallbackThought={
                    message.senderLabel === 'operator'
                      ? null
                      : (summariesByLabel[message.senderLabel.toLowerCase()] ?? null)
                  }
                />
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

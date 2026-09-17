import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Clock3, Lightbulb, MessageSquare, PlusSquare, Send, Sparkles, X } from 'lucide-react';
import type { AgentHubTipPayload } from '../../../shared/agent-hub-sse';
import type {
  AgentConversation,
  MessageLinkedHandoff,
  ScopedConversationResolution,
} from '../../../shared/agent-conversations';
import {
  pageScopeFromSubject,
  scopeChangeDismissKey,
  shouldOfferScopeChangePrompt,
  type ConversationPageScope,
} from '../../../shared/conversation-scope-prompt.ts';
import { api, send } from '../api';
import { useDebouncedAgentHubTip } from '../useAgentHubTips';
import { useConversationSelection } from '../useConversationSelection';
import { dismissScopeChangePair, isScopeChangeDismissed } from '../scopeChangeDismiss';
import { useAgentHubTipsSubscribe } from './AgentHubTipsContext';
import { ConversationTurn } from './ConversationTurn';
import { shortConversationId } from './formatting';
import type { AgentBadgePresence, AgentBadgeProfile } from './AgentBadge';
import { formatDateTime } from './formatting';
import { useMentionHandoffCompose } from './useMentionHandoffCompose';
import { MentionHandoffPreview } from './MentionHandoffCompose';
import { drawerSelectionIssueMessage } from './conversationSelectionUi';
import { useCommandAiPageContext } from '../useCommandAiPageContext';
import type { BreadcrumbData } from './breadcrumbs';

type Conversation = AgentConversation;
type Message = {
  id: string;
  senderLabel: string;
  sentAt: string;
  body: string;
  thoughtSummary?: string | null;
  provenance?: 'UNKNOWN' | 'ASSERTED' | 'VERIFIED';
  linkedHandoffs?: MessageLinkedHandoff[];
};
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
type PanelView = 'home' | 'history' | 'thread';

const deriveTitle = (body: string) => {
  const line = body.trim().split(/\n/)[0] ?? '';
  if (!line) return 'Command AI inquiry';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
};

export function CommandAiFab({ onClick, open }: { onClick: () => void; open: boolean }) {
  if (open) return null;
  return (
    <button
      type="button"
      className="command-ai-fab"
      onClick={onClick}
      aria-label="Open Command AI"
      title="Command AI"
    >
      <Sparkles aria-hidden="true" />
    </button>
  );
}

export function CommandAiPanel({
  open,
  onClose,
  liveTipsEnabled = false,
  breadcrumbData = { clients: [], projects: [] },
}: {
  open: boolean;
  onClose: () => void;
  liveTipsEnabled?: boolean;
  breadcrumbData?: BreadcrumbData;
}) {
  const {
    conversationId: bridgeConversationId,
    drawerIssue,
    hint,
    applySelection,
    clearSelection,
    conversationsOpenPath,
    onConversationsPage,
  } = useConversationSelection();
  const pageContext = useCommandAiPageContext(breadcrumbData);
  const pageScope = pageScopeFromSubject(
    pageContext?.subjectType ?? null,
    pageContext?.subjectId ?? null,
  );
  const [view, setView] = useState<PanelView>('home');
  const [scopePromptVisible, setScopePromptVisible] = useState(false);
  const [canonicalChoice, setCanonicalChoice] = useState<ScopedConversationResolution | null>(null);
  const scopePromptEvaluatedRef = useRef(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [compose, setCompose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [agentProfiles, setAgentProfiles] = useState<Record<string, AgentBadgeProfile>>({});
  const [presenceByLabel, setPresenceByLabel] = useState<Record<string, AgentBadgePresence>>({});
  const [summariesByLabel, setSummariesByLabel] = useState<Record<string, string>>({});
  const [registeredLabels, setRegisteredLabels] = useState<string[]>([]);
  const { offered, confirmed, toggle } = useMentionHandoffCompose(compose, registeredLabels);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<Conversation | null>(null);
  const threadRequestRef = useRef(0);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const loadAgents = useCallback(async () => {
    try {
      const [directory, live, summaries] = await Promise.all([
        api<{ agents?: Array<{ label: string; displayName: string; trustLevel: string }> }>(
          '/agents/directory',
        ),
        api<{
          presence?: Array<{ agentLabel: string; state: string; lastActivityAt: string | null }>;
        }>('/agents/presence'),
        api<{ summaries?: Array<{ agentLabel: string; text: string }> }>('/agent-summaries'),
      ]);
      const profiles: Record<string, AgentBadgeProfile> = {};
      for (const agent of directory.agents ?? []) {
        profiles[agent.label.toLowerCase()] = {
          label: agent.label,
          displayName: agent.displayName ?? agent.label,
          trustLevel: agent.trustLevel ?? 'UNVERIFIED',
        };
      }
      setAgentProfiles(profiles);
      setRegisteredLabels((directory.agents ?? []).map((agent) => agent.label));
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
    } catch {
      setAgentProfiles({});
      setRegisteredLabels([]);
    }
  }, []);

  const loadConversations = useCallback(async () => {
    const page = await api<Page<Conversation>>('/agent-conversations?state=ACTIVE&limit=50');
    const items = page.items ?? [];
    setConversations(items);
    return items;
  }, []);

  const openThread = useCallback(
    async (conversation: Conversation, options?: { fromBridge?: boolean }) => {
      const requestId = ++threadRequestRef.current;
      if (!options?.fromBridge) {
        applySelection(conversation.id, 'drawer', {
          scopeType: conversation.scope.type,
          scopeId: conversation.scope.id,
          state: conversation.state,
        });
      }
      setSelected(conversation);
      setView('thread');
      setError('');
      const page = await api<Page<Message>>(
        `/agent-conversations/${conversation.id}/messages?limit=50&direction=before`,
      );
      if (requestId !== threadRequestRef.current) return;
      setMessages(page.items);
    },
    [applySelection],
  );

  const refresh = useCallback(async () => {
    try {
      await loadAgents();
      await loadConversations();
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
    }
  }, [loadAgents, loadConversations]);

  useEffect(() => {
    if (!open) {
      scopePromptEvaluatedRef.current = false;
      setScopePromptVisible(false);
      setCanonicalChoice(null);
      return;
    }
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || scopePromptEvaluatedRef.current) return;
    if (!pageScope) {
      scopePromptEvaluatedRef.current = true;
      return;
    }
    if (bridgeConversationId && !hint) return;
    scopePromptEvaluatedRef.current = true;
    if (!bridgeConversationId || !hint) return;
    const threadScope = { type: hint.scopeType, id: hint.scopeId };
    const dismissKey = scopeChangeDismissKey(pageScope, threadScope);
    const dismissed = isScopeChangeDismissed(dismissKey);
    setScopePromptVisible(shouldOfferScopeChangePrompt({ pageScope, threadScope, dismissed }));
  }, [open, bridgeConversationId, hint, pageScope]);

  const subscribeAgentHubTips = useAgentHubTipsSubscribe();
  const handleConversationTip = useCallback(
    (tip: AgentHubTipPayload) => {
      void loadConversations();
      const current = selectedRef.current;
      if (!current) return;
      if (tip.conversationId && tip.conversationId !== current.id) return;
      void openThread(current, { fromBridge: true });
    },
    [loadConversations, openThread],
  );
  useDebouncedAgentHubTip(
    liveTipsEnabled ? subscribeAgentHubTips : null,
    'conversations',
    handleConversationTip,
  );

  useEffect(() => {
    if (!open) return;
    if (drawerIssue && bridgeConversationId) {
      if (selectedRef.current) {
        selectedRef.current = null;
        threadRequestRef.current += 1;
        setSelected(null);
        setMessages([]);
      }
      setView('thread');
      return;
    }
    if (!bridgeConversationId) {
      if (view === 'thread' && !selectedRef.current) setView('home');
      return;
    }
    if (selectedRef.current?.id === bridgeConversationId) return;
    const match = conversations.find((item) => item.id === bridgeConversationId);
    if (match) void openThread(match, { fromBridge: true });
  }, [open, drawerIssue, bridgeConversationId, conversations, openThread, view]);

  useEffect(() => {
    if (view === 'thread') {
      messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    }
  }, [messages, view]);

  const startNew = () => {
    clearSelection('drawer');
    selectedRef.current = null;
    threadRequestRef.current += 1;
    setSelected(null);
    setMessages([]);
    setCompose('');
    setView('home');
    setError('');
    setScopePromptVisible(false);
    setCanonicalChoice(null);
  };

  const openConversationRecord = useCallback(
    async (conversation: Conversation) => {
      await openThread(conversation);
    },
    [openThread],
  );

  const openScopedCanonical = useCallback(
    async (scope: ConversationPageScope) => {
      setBusy(true);
      setError('');
      try {
        const resolution = await api<ScopedConversationResolution>(
          `/agent-conversations/scoped-resolution?scopeType=${scope.type}&scopeId=${encodeURIComponent(scope.id)}`,
        );
        if (resolution.canonicalId) {
          const existing = conversations.find((item) => item.id === resolution.canonicalId);
          if (existing) {
            await openConversationRecord(existing);
          } else {
            const conversation = await api<Conversation>(
              `/agent-conversations/${resolution.canonicalId}`,
            );
            await openConversationRecord(conversation);
          }
          setScopePromptVisible(false);
          setCanonicalChoice(null);
          return;
        }
        if (resolution.secondaryThreads.length > 0) {
          setCanonicalChoice(resolution);
          return;
        }
        const created = await send<Conversation>('/agent-conversations', 'POST', {
          title: `${scope.type} chat`,
          scope: { type: scope.type, id: scope.id },
        });
        await openConversationRecord(created);
        await loadConversations();
        setScopePromptVisible(false);
      } catch (problem) {
        setError((problem as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [conversations, loadConversations, openConversationRecord],
  );

  const startScopedThread = async (scope: ConversationPageScope, secondary = true) => {
    setBusy(true);
    setError('');
    try {
      const created = await send<Conversation>('/agent-conversations', 'POST', {
        title: secondary ? `${scope.type} thread` : `${scope.type} chat`,
        scope: { type: scope.type, id: scope.id },
        secondary,
      });
      await openConversationRecord(created);
      await loadConversations();
      setCanonicalChoice(null);
      setScopePromptVisible(false);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const acceptScopeChange = () => {
    if (!pageScope) return;
    void openScopedCanonical(pageScope);
  };

  const declineScopeChange = () => {
    if (!pageScope) return;
    const threadScope = hint
      ? { type: hint.scopeType, id: hint.scopeId }
      : (selected?.scope ?? { type: 'freeform' as const, id: null });
    dismissScopeChangePair(scopeChangeDismissKey(pageScope, threadScope));
    setScopePromptVisible(false);
  };

  const promoteSecondaryToCanonical = async (conversationId: string) => {
    setBusy(true);
    setError('');
    try {
      const promoted = await send<Conversation>(
        `/agent-conversations/${conversationId}/promote-canonical`,
        'POST',
      );
      await openConversationRecord(promoted);
      await loadConversations();
      setCanonicalChoice(null);
      setScopePromptVisible(false);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showHistory = () => {
    setView('history');
    setError('');
  };

  const leaveHistory = () => {
    setView(selected ? 'thread' : 'home');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = compose.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      let conversation = selected;
      if (!conversation) {
        conversation = await send<Conversation>('/agent-conversations', 'POST', {
          title: deriveTitle(trimmed),
          scope: { type: 'freeform' },
        });
        applySelection(conversation.id, 'drawer', {
          scopeType: conversation.scope.type,
          scopeId: conversation.scope.id,
          state: conversation.state,
        });
        setSelected(conversation);
        setView('thread');
      }
      const message = await send<Message>(
        `/agent-conversations/${conversation.id}/messages`,
        'POST',
        {
          body: trimmed,
          confirmHandoffs: confirmed,
          clientRequestId: crypto.randomUUID(),
        },
      );
      setMessages((current) => [...current, message]);
      setCompose('');
      await loadConversations();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const recent = conversations.slice(0, 5);
  const history = conversations;

  return (
    <aside className="command-ai-panel" aria-label="Command AI">
      <header className="command-ai-head">
        <div className="command-ai-brand">
          <Sparkles aria-hidden="true" />
          <strong>Command AI</strong>
        </div>
        <div className="command-ai-actions">
          <button
            type="button"
            className={`command-ai-action ${view === 'history' ? 'active' : ''}`}
            onClick={() => (view === 'history' ? leaveHistory() : showHistory())}
            aria-pressed={view === 'history'}
          >
            <Clock3 aria-hidden="true" /> {view === 'history' ? 'Back' : 'History'}
          </button>
          <button type="button" className="command-ai-action" onClick={() => startNew()}>
            <PlusSquare aria-hidden="true" /> New
          </button>
          {pageScope && (
            <button
              type="button"
              className="command-ai-action"
              disabled={busy}
              onClick={() => void startScopedThread(pageScope)}
            >
              <PlusSquare aria-hidden="true" /> New thread
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close Command AI"
          >
            <X />
          </button>
        </div>
      </header>

      {error && (
        <p className="command-ai-error" role="alert">
          {error}
        </p>
      )}

      {scopePromptVisible && pageContext && pageScope && (
        <section className="command-ai-scope-prompt" aria-label="Scope change prompt">
          <p>
            Switch to <strong>{pageContext.label}</strong> chat?
          </p>
          <div className="command-ai-scope-prompt-actions">
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={acceptScopeChange}
            >
              Switch
            </button>
            <button
              type="button"
              className="secondary-btn"
              disabled={busy}
              onClick={declineScopeChange}
            >
              Keep current thread
            </button>
          </div>
        </section>
      )}

      {canonicalChoice && pageScope && (
        <section className="command-ai-scope-prompt" aria-label="Choose canonical thread">
          <p>
            No canonical thread is active for this scope. Promote an existing thread or create a new
            one.
          </p>
          <ul className="command-ai-canonical-choice">
            {canonicalChoice.secondaryThreads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={busy}
                  onClick={() => void promoteSecondaryToCanonical(thread.id)}
                >
                  Promote “{thread.title}”
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="primary-btn"
            disabled={busy}
            onClick={() => void startScopedThread(pageScope, false)}
          >
            Create new canonical thread
          </button>
        </section>
      )}

      <div className="command-ai-body">
        {view === 'history' && (
          <section className="command-ai-history" aria-label="Chat history">
            <h3>Chat history</h3>
            <p className="field-hint">
              Linked threads show a short conversation id beside the timestamp.
            </p>
            {history.length === 0 && <p className="empty">No Command AI threads yet.</p>}
            <ul className="command-ai-history-list">
              {history.map((conversation) => (
                <li key={conversation.id}>
                  <button type="button" onClick={() => void openThread(conversation)}>
                    <strong>{conversation.title}</strong>
                    <span>
                      {formatDateTime(conversation.updatedAt)} ·{' '}
                      {shortConversationId(conversation.id)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {view === 'home' && (
          <section className="command-ai-home" aria-label="Command AI welcome">
            <div className="command-ai-welcome">
              <Lightbulb aria-hidden="true" />
              <h3>What are you curious about?</h3>
              <p>
                Ask a question, mention an agent with @label, or resume a recent thread. This drawer
                and the Conversations page show the same selected thread across every scope — they
                are not two separate chats.
              </p>
            </div>
            {recent.length > 0 && (
              <div className="command-ai-recent">
                <h4>Recent chats</h4>
                <ul>
                  {recent.map((conversation) => (
                    <li key={conversation.id}>
                      <button type="button" onClick={() => void openThread(conversation)}>
                        <strong>{conversation.title}</strong>
                        <span>
                          {formatDateTime(conversation.updatedAt)} ·{' '}
                          {shortConversationId(conversation.id)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {conversations.length > recent.length && (
                  <button type="button" className="text-btn" onClick={() => setView('history')}>
                    View all
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {view === 'thread' && drawerIssue && bridgeConversationId && (
          <section
            className="command-ai-thread command-ai-selection-issue"
            aria-label="Selected conversation unavailable in Command AI"
          >
            <div className="command-ai-welcome">
              <MessageSquare aria-hidden="true" />
              <h3>Selected thread unavailable here</h3>
              <p>{drawerSelectionIssueMessage(drawerIssue)}</p>
              <Link className="primary-btn" to={conversationsOpenPath(bridgeConversationId)}>
                Open full view
              </Link>
            </div>
          </section>
        )}

        {view === 'thread' && selected && !drawerIssue && (
          <section className="command-ai-thread" aria-label={selected.title}>
            <div className="command-ai-thread-head">
              <button type="button" className="text-btn" onClick={() => startNew()}>
                ← New chat
              </button>
              <h3>
                {selected.title}{' '}
                {selected.scope.type !== 'freeform' && !selected.isCanonical && (
                  <span className="secondary-thread-badge">Secondary thread</span>
                )}
              </h3>
              <p className="field-hint">
                Conversation {shortConversationId(selected.id)} · {selected.scope.type}
                {selected.scope.id ? ` · ${selected.scope.id}` : ''} · synchronized with full view
                {onConversationsPage ? '' : ' · '}
                {!onConversationsPage && (
                  <Link to={conversationsOpenPath(selected.id)}>Open full view</Link>
                )}
              </p>
            </div>
            <div className="command-ai-messages">
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
              <div ref={messagesEndRef} />
            </div>
          </section>
        )}
      </div>

      <footer className="command-ai-foot">
        {pageContext && (
          <div className="command-ai-page-context" aria-label="Current page context">
            <p className="command-ai-page-context-label">
              <strong>Current page context:</strong> {pageContext.label}
            </p>
            <p className="field-hint">
              Included with your next message only. Not saved to the thread unless you send.
            </p>
          </div>
        )}
        <form
          className="command-ai-compose"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <textarea
            value={compose}
            onChange={(event) => setCompose(event.target.value)}
            placeholder="Ask away"
            aria-label="Command AI message"
            maxLength={4000}
            rows={3}
          />
          <MentionHandoffPreview offered={offered} confirmed={confirmed} onToggle={toggle} />
          <div className="command-ai-compose-actions">
            <span className="field-hint">Command AI can make mistakes. Check important info.</span>
            <button type="submit" className="primary-btn" disabled={busy || !compose.trim()}>
              <Send aria-hidden="true" /> {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </footer>
    </aside>
  );
}

export function CommandAiTopbarToggle({ onClick, open }: { onClick: () => void; open: boolean }) {
  return (
    <button
      type="button"
      className={`top-action command-ai-top-toggle ${open ? 'active' : ''}`}
      onClick={onClick}
      aria-pressed={open}
    >
      <MessageSquare aria-hidden="true" /> Command AI
    </button>
  );
}

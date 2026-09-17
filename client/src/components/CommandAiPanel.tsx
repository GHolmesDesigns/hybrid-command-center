import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Clock3,
  Lightbulb,
  Loader2,
  MessageSquare,
  PlusSquare,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import type { AgentHubTipPayload } from '../../../shared/agent-hub-sse';
import type {
  AssistantPendingApproval,
  AssistantTurnState,
  CommandAiAssistantSettings,
  AssistantKeyMetadata,
} from '../../../shared/command-ai-assistant';
import { ASSISTANT_AGENT_LABEL } from '../../../shared/mcp-agent-registry';
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
import { useDebouncedAgentHubTip, type AssistantStreamCallbacks } from '../useAgentHubTips';
import { useConversationSelection } from '../useConversationSelection';
import { dismissScopeChangePair, isScopeChangeDismissed } from '../scopeChangeDismiss';
import { useAgentHubLiveConnection, useAgentHubTipsSubscribe } from './AgentHubTipsContext';
import { AssistantApprovalCard } from './AssistantApprovalCard';
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
  senderKind?: 'operator' | 'agent' | 'assistant';
  sentAt: string;
  body: string;
  thoughtSummary?: string | null;
  provenance?: 'UNKNOWN' | 'ASSERTED' | 'VERIFIED';
  linkedHandoffs?: MessageLinkedHandoff[];
};

export type CommandAiAssistantBundle = {
  assistant: CommandAiAssistantSettings;
  key: AssistantKeyMetadata;
  ready: boolean;
};

const TURN_STATE_LABEL: Record<string, string> = {
  running: 'Assistant running…',
  started: 'Assistant running…',
  awaiting_approval: 'Awaiting your approval',
  finished: 'Assistant finished',
  failed: 'Assistant failed',
  cancelled: 'Assistant cancelled',
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
  assistantBundle = {
    assistant: {
      enabled: false,
      provider: 'openai',
      model: 'gpt-4o-mini',
      dailyTurnCap: 100,
      dailyTokenCap: 300_000,
      scopes: ['workspace:read', 'workspace:write'],
    },
    key: { provider: 'openai', hasKey: false, keyLast4: null },
    ready: false,
  },
  breadcrumbData = { clients: [], projects: [] },
}: {
  open: boolean;
  onClose: () => void;
  liveTipsEnabled?: boolean;
  assistantBundle?: CommandAiAssistantBundle;
  breadcrumbData?: BreadcrumbData;
}) {
  const assistantEnabled = assistantBundle.assistant.enabled;
  const assistantReady = assistantBundle.ready;
  const assistantKeyed = assistantBundle.key.hasKey || assistantReady;
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
  const [turnState, setTurnState] = useState<AssistantTurnState | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<AssistantPendingApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [turnBusy, setTurnBusy] = useState(false);
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

  const clearAssistantUi = useCallback(() => {
    setTurnState(null);
    setStreamingText('');
    setStreamingTurnId(null);
    setApprovals([]);
  }, []);

  const loadTurnState = useCallback(
    async (conversationId: string) => {
      if (!assistantEnabled || !assistantReady) {
        clearAssistantUi();
        return;
      }
      try {
        const result = await api<{ turn: AssistantTurnState | null }>(
          `/agent-conversations/${conversationId}/assistant/turn`,
        );
        setTurnState(result.turn);
        if (result.turn?.state === 'awaiting_approval') {
          const pending = await api<{ approvals: AssistantPendingApproval[] }>(
            `/agent-conversations/${conversationId}/assistant/approvals`,
          );
          setApprovals(pending.approvals ?? []);
        } else {
          setApprovals([]);
        }
      } catch {
        clearAssistantUi();
      }
    },
    [assistantEnabled, assistantReady, clearAssistantUi],
  );

  const reloadThreadMessages = useCallback(
    async (conversation: Conversation) => {
      const page = await api<Page<Message>>(
        `/agent-conversations/${conversation.id}/messages?limit=50&direction=before`,
      );
      setMessages(page.items);
      clearAssistantUi();
      await loadTurnState(conversation.id);
    },
    [clearAssistantUi, loadTurnState],
  );

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
      clearAssistantUi();
      const page = await api<Page<Message>>(
        `/agent-conversations/${conversation.id}/messages?limit=50&direction=before`,
      );
      if (requestId !== threadRequestRef.current) return;
      setMessages(page.items);
      if (requestId !== threadRequestRef.current) return;
      await loadTurnState(conversation.id);
    },
    [applySelection, clearAssistantUi, loadTurnState],
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

  const agentHubLive = useAgentHubLiveConnection();
  const subscribeAgentHubTips = useAgentHubTipsSubscribe();
  const handleConversationTip = useCallback(
    (tip: AgentHubTipPayload) => {
      void loadConversations();
      const current = selectedRef.current;
      if (!current) return;
      if (tip.conversationId && tip.conversationId !== current.id) return;
      void reloadThreadMessages(current);
    },
    [loadConversations, reloadThreadMessages],
  );
  useDebouncedAgentHubTip(
    liveTipsEnabled ? subscribeAgentHubTips : null,
    'conversations',
    handleConversationTip,
  );
  const handleCoordinationTip = useCallback(() => {
    const current = selectedRef.current;
    if (!current) return;
    void reloadThreadMessages(current);
  }, [reloadThreadMessages]);
  useDebouncedAgentHubTip(
    liveTipsEnabled ? subscribeAgentHubTips : null,
    'coordination',
    handleCoordinationTip,
  );

  const handleAssistantDelta = useCallback(
    (frame: Parameters<NonNullable<AssistantStreamCallbacks['onDelta']>>[0]) => {
      const current = selectedRef.current;
      if (!current || frame.conversationId !== current.id) return;
      setStreamingTurnId(frame.turnId);
      setStreamingText((text) => text + frame.delta);
    },
    [],
  );

  const handleAssistantTurnState = useCallback(
    (frame: Parameters<NonNullable<AssistantStreamCallbacks['onTurnState']>>[0]) => {
      const current = selectedRef.current;
      if (!current || frame.conversationId !== current.id) return;
      if (frame.state === 'finished' || frame.state === 'failed' || frame.state === 'cancelled') {
        void reloadThreadMessages(current);
        return;
      }
      if (frame.state === 'awaiting_approval') {
        void loadTurnState(current.id);
        return;
      }
      setTurnState((prev) =>
        prev
          ? { ...prev, state: frame.state === 'started' ? 'running' : prev.state }
          : {
              conversationId: current.id,
              turnId: frame.turnId,
              state: 'running',
              profile: 'light',
              toolCallCount: 0,
              outputTokenCount: 0,
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              cancelRequested: false,
              pendingApprovalIds: [],
            },
      );
    },
    [loadTurnState, reloadThreadMessages],
  );

  const streamCallbacks = useMemo(
    (): AssistantStreamCallbacks => ({
      onDelta: handleAssistantDelta,
      onTurnState: handleAssistantTurnState,
    }),
    [handleAssistantDelta, handleAssistantTurnState],
  );

  useEffect(() => {
    if (!open || !liveTipsEnabled || !assistantEnabled || !assistantReady) return;
    const conversationId = selected?.id;
    if (!conversationId || !agentHubLive) return;
    return agentHubLive.subscribeConversation(conversationId, streamCallbacks);
  }, [
    open,
    liveTipsEnabled,
    assistantEnabled,
    assistantReady,
    selected?.id,
    agentHubLive,
    streamCallbacks,
  ]);

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

  const cancelTurn = async () => {
    if (!selected || turnBusy) return;
    setTurnBusy(true);
    setError('');
    try {
      await send(`/agent-conversations/${selected.id}/assistant/cancel`, 'POST', {});
      await reloadThreadMessages(selected);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setTurnBusy(false);
    }
  };

  const respondToApproval = async (approvalId: string, approved: boolean) => {
    if (!selected || approvalBusy) return;
    setApprovalBusy(true);
    setError('');
    try {
      await send(
        `/agent-conversations/${selected.id}/assistant/approvals/${approvalId}/respond`,
        'POST',
        { approved },
      );
      await reloadThreadMessages(selected);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setApprovalBusy(false);
    }
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
      if (assistantEnabled && assistantReady) {
        setStreamingText('');
        setStreamingTurnId(null);
      }
      const message = await send<Message>(
        `/agent-conversations/${conversation.id}/messages`,
        'POST',
        {
          body: trimmed,
          confirmHandoffs: confirmed,
          clientRequestId: crypto.randomUUID(),
          ...(pageContext ? { pageContext } : {}),
        },
      );
      setMessages((current) => [...current, message]);
      setCompose('');
      await loadConversations();
      if (assistantEnabled && assistantReady) {
        await loadTurnState(conversation.id);
      }
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
                are not two separate chats. MCP agents can post in a thread as chat peers; a checked
                @mention opens a handoff for claim and complete.
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
            {assistantEnabled && assistantReady && turnState && (
              <div className="command-ai-turn-status" role="status" aria-live="polite">
                <Loader2 className="spin" aria-hidden="true" />
                <span>
                  {TURN_STATE_LABEL[turnState.state] ?? 'Assistant active'}
                  {streamingTurnId ? ` · turn ${streamingTurnId.slice(0, 8)}` : ''}
                </span>
                {(turnState.state === 'running' || turnState.state === 'awaiting_approval') && (
                  <button
                    type="button"
                    className="text-btn"
                    disabled={turnBusy}
                    onClick={() => void cancelTurn()}
                  >
                    Cancel turn
                  </button>
                )}
              </div>
            )}
            {approvals.length > 0 && (
              <div className="command-ai-approvals" aria-label="Pending assistant approvals">
                {approvals.map((approval) => (
                  <AssistantApprovalCard
                    key={approval.id}
                    approval={approval}
                    busy={approvalBusy}
                    onApprove={() => void respondToApproval(approval.id, true)}
                    onDecline={() => void respondToApproval(approval.id, false)}
                  />
                ))}
              </div>
            )}
            <div className="command-ai-messages">
              {messages.map((message) => (
                <ConversationTurn
                  key={message.id}
                  message={message}
                  agentProfiles={agentProfiles}
                  presenceByLabel={presenceByLabel}
                  fallbackThought={
                    message.senderLabel === 'operator' ||
                    message.senderKind === 'assistant' ||
                    message.senderLabel.toLowerCase() === ASSISTANT_AGENT_LABEL
                      ? null
                      : (summariesByLabel[message.senderLabel.toLowerCase()] ?? null)
                  }
                />
              ))}
              {streamingText && (
                <article
                  className="conversation-turn assistant-turn command-ai-streaming-bubble"
                  aria-label="Command AI streaming response"
                >
                  <div className="agent-badge assistant-badge">
                    <span className="agent-badge-mark assistant" aria-hidden="true">
                      <Sparkles />
                    </span>
                    <div className="agent-badge-copy">
                      <strong>Command AI</strong>
                      <span className="agent-badge-meta">Streaming…</span>
                    </div>
                  </div>
                  <div className="conversation-turn-body">
                    <p>{streamingText}</p>
                  </div>
                </article>
              )}
              <div ref={messagesEndRef} />
            </div>
          </section>
        )}
      </div>

      <footer className="command-ai-foot">
        {assistantEnabled && !assistantKeyed && (
          <p className="command-ai-assistant-notice" role="status">
            Add an API key in <Link to="/settings">Settings</Link> to run Command AI assistant
            turns.
          </p>
        )}
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

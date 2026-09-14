import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  conversationsPathWithOpen,
  drawerSelectionIssue,
  fullViewSelectionIssue,
  readOpenConversationParam,
  selectionUpdateEcho,
  type ConversationSelectionHint,
  type ConversationSelectionSource,
} from '../../../shared/conversation-selection.ts';
import {
  ConversationSelectionContext,
  type ConversationSelectionBridge,
} from './ConversationSelectionContext';

export function ConversationSelectionProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const onConversationsPage = location.pathname === '/agents/conversations';
  const urlConversationId = readOpenConversationParam(searchParams.toString());
  const [memoryConversationId, setMemoryConversationId] = useState<string | null>(null);
  const [hintsById, setHintsById] = useState<
    Record<string, ConversationSelectionHint | null | undefined>
  >({});
  const [source, setSource] = useState<ConversationSelectionSource | null>(null);
  const echoGuardRef = useRef<ConversationSelectionSource | null>(null);
  const wasOnConversationsPageRef = useRef(onConversationsPage);
  const lastAppliedRef = useRef<{ id: string | null; source: ConversationSelectionSource | null }>({
    id: null,
    source: null,
  });

  const conversationId = onConversationsPage
    ? (urlConversationId ?? memoryConversationId)
    : memoryConversationId;
  const hint = conversationId ? (hintsById[conversationId] ?? null) : null;

  useEffect(() => {
    const enteredConversationsPage =
      onConversationsPage && !wasOnConversationsPageRef.current;
    wasOnConversationsPageRef.current = onConversationsPage;
    if (!enteredConversationsPage) return;
    if (urlConversationId || !memoryConversationId) return;
    echoGuardRef.current = 'drawer';
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('open', memoryConversationId);
        return next;
      },
      { replace: true },
    );
  }, [onConversationsPage, urlConversationId, memoryConversationId, setSearchParams]);

  useEffect(() => {
    if (echoGuardRef.current) {
      echoGuardRef.current = null;
      return;
    }
    if (!onConversationsPage) return;
    setSource('url');
    setMemoryConversationId(urlConversationId);
    lastAppliedRef.current = { id: urlConversationId, source: 'url' };
  }, [onConversationsPage, urlConversationId]);

  useEffect(() => {
    if (onConversationsPage) return;
    if (urlConversationId) setMemoryConversationId(urlConversationId);
  }, [onConversationsPage, urlConversationId]);

  const registerHint = useCallback(
    (nextConversationId: string, nextHint: ConversationSelectionHint | null) => {
      setHintsById((current) => ({ ...current, [nextConversationId]: nextHint }));
    },
    [],
  );

  const applySelection = useCallback(
    (
      nextConversationId: string | null,
      nextSource: Exclude<ConversationSelectionSource, 'url'>,
      nextHint?: ConversationSelectionHint | null,
    ) => {
      if (
        selectionUpdateEcho(
          conversationId,
          nextConversationId,
          nextSource,
          lastAppliedRef.current.source,
        )
      ) {
        return;
      }
      lastAppliedRef.current = { id: nextConversationId, source: nextSource };
      setSource(nextSource);
      setMemoryConversationId(nextConversationId);
      if (nextHint !== undefined && nextConversationId) {
        setHintsById((current) => ({ ...current, [nextConversationId]: nextHint }));
      }

      if (onConversationsPage) {
        echoGuardRef.current = nextSource;
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            if (nextConversationId) next.set('open', nextConversationId);
            else next.delete('open');
            return next;
          },
          { replace: true },
        );
      }
    },
    [conversationId, onConversationsPage, setSearchParams],
  );

  const clearSelection = useCallback(
    (nextSource: ConversationSelectionSource) => {
      applySelection(null, nextSource === 'drawer' ? 'drawer' : 'full-view', null);
    },
    [applySelection],
  );

  const value = useMemo<ConversationSelectionBridge>(
    () => ({
      conversationId,
      source,
      drawerIssue: drawerSelectionIssue(conversationId, hint),
      fullViewIssue: fullViewSelectionIssue(conversationId, hint),
      hint,
      onConversationsPage,
      applySelection,
      registerHint,
      clearSelection,
      conversationsOpenPath: conversationsPathWithOpen,
    }),
    [
      applySelection,
      clearSelection,
      conversationId,
      hint,
      onConversationsPage,
      registerHint,
      source,
    ],
  );

  return (
    <ConversationSelectionContext.Provider value={value}>
      {children}
    </ConversationSelectionContext.Provider>
  );
}

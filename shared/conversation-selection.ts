import type { ConversationScopeType, ConversationState } from './agent-conversations.ts';

export const CONVERSATION_SELECTION_SOURCES = ['url', 'full-view', 'drawer'] as const;
export type ConversationSelectionSource = (typeof CONVERSATION_SELECTION_SOURCES)[number];

export const CONVERSATION_SELECTION_ISSUES = [
  'missing',
  'unsupported_scope',
  'archived_in_drawer',
] as const;
export type ConversationSelectionIssue = (typeof CONVERSATION_SELECTION_ISSUES)[number];

export type ConversationSelectionHint = {
  scopeType: ConversationScopeType;
  scopeId: string | null;
  state: ConversationState;
};

export type ConversationSelectionSnapshot = {
  conversationId: string | null;
  source: ConversationSelectionSource | null;
  issue: ConversationSelectionIssue | null;
};

export function readOpenConversationParam(search: string): string | null {
  const open = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    .get('open')
    ?.trim();
  return open || null;
}

export function conversationOpenQuery(conversationId: string): string {
  return `open=${encodeURIComponent(conversationId)}`;
}

export function conversationsPathWithOpen(conversationId: string): string {
  return `/agents/conversations?${conversationOpenQuery(conversationId)}`;
}

/** The drawer lists active threads for every scope; archived and missing stay fail-closed. */
export function drawerSelectionIssue(
  conversationId: string | null,
  hint: ConversationSelectionHint | null | undefined,
): ConversationSelectionIssue | null {
  if (!conversationId) return null;
  if (!hint) return 'missing';
  if (hint.state === 'ARCHIVED') return 'archived_in_drawer';
  return null;
}

/** Full view may show any accessible conversation; missing is the only fail-closed case. */
export function fullViewSelectionIssue(
  conversationId: string | null,
  hint: ConversationSelectionHint | null | undefined,
): ConversationSelectionIssue | null {
  if (!conversationId) return null;
  if (!hint) return 'missing';
  return null;
}

/** Loop protection: skip when the same source reapplies an unchanged id. */
export function selectionUpdateEcho(
  previousId: string | null,
  nextId: string | null,
  source: ConversationSelectionSource,
  lastAppliedSource: ConversationSelectionSource | null,
): boolean {
  return previousId === nextId && source === lastAppliedSource;
}

export function mergeSelectionSnapshot(
  conversationId: string | null,
  source: ConversationSelectionSource | null,
  hint: ConversationSelectionHint | null | undefined,
  surface: 'drawer' | 'full-view',
): ConversationSelectionSnapshot {
  const issueFn = surface === 'drawer' ? drawerSelectionIssue : fullViewSelectionIssue;
  return {
    conversationId,
    source,
    issue: issueFn(conversationId, hint),
  };
}

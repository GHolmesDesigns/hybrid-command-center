import type { ConversationScopeType } from './agent-conversations.ts';

export type ConversationPageScope = {
  type: Exclude<ConversationScopeType, 'freeform'>;
  id: string;
};

export type ConversationThreadScope = {
  type: ConversationScopeType;
  id: string | null;
};

/** Session-local dismiss key for a page scope and selected thread scope pair. */
export function scopeChangeDismissKey(
  pageScope: ConversationPageScope,
  threadScope: ConversationThreadScope,
): string {
  return `${pageScope.type}:${pageScope.id}|${threadScope.type}:${threadScope.id ?? ''}`;
}

/** True when the drawer should offer switching to the page's scoped chat. */
export function shouldOfferScopeChangePrompt(input: {
  pageScope: ConversationPageScope | null;
  threadScope: ConversationThreadScope | null;
  dismissed: boolean;
}): boolean {
  const { pageScope, threadScope, dismissed } = input;
  if (!pageScope || !threadScope || dismissed) return false;
  if (threadScope.type === pageScope.type && threadScope.id === pageScope.id) return false;
  return true;
}

export function pageScopeFromSubject(
  subjectType: 'client' | 'project' | 'task' | 'signal_post' | null,
  subjectId: string | null,
): ConversationPageScope | null {
  if (!subjectType || subjectType === 'signal_post' || !subjectId) return null;
  return { type: subjectType, id: subjectId };
}

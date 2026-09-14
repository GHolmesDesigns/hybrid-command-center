import { createContext } from 'react';
import type {
  ConversationSelectionHint,
  ConversationSelectionIssue,
  ConversationSelectionSource,
} from '../../../shared/conversation-selection.ts';

export type ConversationSelectionBridge = {
  conversationId: string | null;
  source: ConversationSelectionSource | null;
  drawerIssue: ConversationSelectionIssue | null;
  fullViewIssue: ConversationSelectionIssue | null;
  hint: ConversationSelectionHint | null;
  onConversationsPage: boolean;
  applySelection: (
    conversationId: string | null,
    source: Exclude<ConversationSelectionSource, 'url'>,
    hint?: ConversationSelectionHint | null,
  ) => void;
  registerHint: (conversationId: string, hint: ConversationSelectionHint | null) => void;
  clearSelection: (source: ConversationSelectionSource) => void;
  conversationsOpenPath: (conversationId: string) => string;
};

export const ConversationSelectionContext = createContext<ConversationSelectionBridge | null>(null);

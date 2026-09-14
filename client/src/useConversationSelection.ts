import { useContext } from 'react';
import { ConversationSelectionContext } from './components/ConversationSelectionContext';

export function useConversationSelection() {
  const bridge = useContext(ConversationSelectionContext);
  if (!bridge) {
    throw new Error('useConversationSelection requires ConversationSelectionProvider');
  }
  return bridge;
}

export function useOptionalConversationSelection() {
  return useContext(ConversationSelectionContext);
}

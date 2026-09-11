import { createContext, useContext } from 'react';
import type { AgentHubTipListener } from '../useAgentHubTips';

export const AgentHubTipsContext = createContext<
  ((listener: AgentHubTipListener) => () => void) | null
>(null);

export function useAgentHubTipsSubscribe() {
  return useContext(AgentHubTipsContext);
}

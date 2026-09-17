import { createContext, useContext } from 'react';
import type { AgentHubLiveConnection } from '../useAgentHubTips';

export const AgentHubTipsContext = createContext<AgentHubLiveConnection | null>(null);

export function useAgentHubTipsSubscribe() {
  const connection = useContext(AgentHubTipsContext);
  return connection?.subscribe ?? null;
}

export function useAgentHubLiveConnection() {
  return useContext(AgentHubTipsContext);
}

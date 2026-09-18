import { api } from './api';
import type { AgentBadgePresence } from './components/AgentBadge';

export async function loadAgentPresenceByLabel(): Promise<Record<string, AgentBadgePresence>> {
  const live = await api<{
    presence?: Array<{ agentLabel: string; state: string; lastActivityAt: string | null }>;
  }>('/agents/presence');
  return Object.fromEntries(
    (live.presence ?? []).map((row) => [
      row.agentLabel.toLowerCase(),
      { state: row.state, lastActivityAt: row.lastActivityAt },
    ]),
  );
}

import { z } from 'zod';
import type { Db } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import {
  AGENT_HUB_LIVE_TIPS_SETTING_KEY,
  DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS,
  type AgentHubLiveTipsSettings,
} from '../../shared/agent-hub-sse.ts';

export const agentHubLiveTipsInput = z.object({
  enabled: z.boolean(),
}) satisfies z.ZodType<AgentHubLiveTipsSettings>;

export function readAgentHubLiveTips(db: Db): AgentHubLiveTipsSettings {
  const raw = getSetting(db, AGENT_HUB_LIVE_TIPS_SETTING_KEY);
  if (!raw) return { ...DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS };
  try {
    const stored = JSON.parse(raw) as unknown;
    return agentHubLiveTipsInput.parse(stored);
  } catch {
    return { ...DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS };
  }
}

export function updateAgentHubLiveTips(db: Db, data: AgentHubLiveTipsSettings) {
  const parsed = agentHubLiveTipsInput.parse(data);
  setSetting(db, AGENT_HUB_LIVE_TIPS_SETTING_KEY, JSON.stringify(parsed));
  return { liveTips: parsed };
}

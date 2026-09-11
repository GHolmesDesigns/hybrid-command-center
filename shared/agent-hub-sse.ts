/**
 * Agent Hub live tip vocabulary (C219 / #605).
 *
 * SSE payloads name affected feeds only — never message bodies, counts, or other authoritative
 * business data. The shell rereads HTTP state after each tip, the same discipline as MCP change
 * feeds.
 */
export const AGENT_HUB_TIP_FEEDS = ['conversations', 'notifications'] as const;
export type AgentHubTipFeed = (typeof AGENT_HUB_TIP_FEEDS)[number];

export const AGENT_HUB_TIP_ALLOWED_KEYS = ['feeds', 'conversationId'] as const;

export type AgentHubTipPayload = {
  feeds: AgentHubTipFeed[];
  conversationId?: string;
};

export const AGENT_HUB_LIVE_TIPS_SETTING_KEY = 'agent_hub_live_tips';

export type AgentHubLiveTipsSettings = {
  enabled: boolean;
};

export const DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS: AgentHubLiveTipsSettings = {
  enabled: false,
};

const isFeed = (value: unknown): value is AgentHubTipFeed =>
  typeof value === 'string' && (AGENT_HUB_TIP_FEEDS as readonly string[]).includes(value);

/** True when `value` is a tip with allowed keys only and at least one known feed. */
export function isAgentHubTipPayload(value: unknown): value is AgentHubTipPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(AGENT_HUB_TIP_ALLOWED_KEYS as readonly string[]).includes(key)) return false;
  }
  if (!Array.isArray(record.feeds) || record.feeds.length === 0) return false;
  if (!record.feeds.every(isFeed)) return false;
  if (record.conversationId !== undefined && typeof record.conversationId !== 'string')
    return false;
  return true;
}

export function agentHubLiveTipsIssues(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return ['Expected a live-tips settings object.'];
  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(record))
    if (key !== 'enabled') issues.push(`Unknown field "${key}".`);
  if (!('enabled' in record)) issues.push('Missing enabled.');
  else if (typeof record.enabled !== 'boolean') issues.push('enabled must be a boolean.');
  return issues;
}

export function parseAgentHubLiveTipsSettings(value: unknown): AgentHubLiveTipsSettings {
  return agentHubLiveTipsIssues(value).length === 0
    ? { enabled: (value as AgentHubLiveTipsSettings).enabled }
    : { ...DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS };
}

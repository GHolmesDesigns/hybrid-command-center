import { describe, expect, it } from 'vitest';
import {
  AGENT_HUB_TIP_ALLOWED_KEYS,
  isAgentHubTipPayload,
  parseAgentHubLiveTipsSettings,
} from './agent-hub-sse.ts';

describe('agent hub SSE tip payload', () => {
  it('accepts feeds-only tips and optional conversationId', () => {
    expect(isAgentHubTipPayload({ feeds: ['notifications'] })).toBe(true);
    expect(isAgentHubTipPayload({ feeds: ['conversations'], conversationId: 'thread-1' })).toBe(
      true,
    );
    expect(isAgentHubTipPayload({ feeds: ['coordination'] })).toBe(true);
  });

  it('rejects authoritative or unknown fields', () => {
    expect(isAgentHubTipPayload({ feeds: ['notifications'], unreadCount: 3 })).toBe(false);
    expect(isAgentHubTipPayload({ feeds: ['conversations'], body: 'hello' })).toBe(false);
    expect(isAgentHubTipPayload({ feeds: ['conversations'], messages: [] })).toBe(false);
    expect(isAgentHubTipPayload({ feeds: ['presence'] })).toBe(false);
    expect(isAgentHubTipPayload({ feeds: [], conversationId: 'x' })).toBe(false);
    expect(isAgentHubTipPayload({ feeds: ['conversations'], conversationId: 4 })).toBe(false);
    expect(isAgentHubTipPayload(null)).toBe(false);
  });

  it('documents the allowed key list for integration tests', () => {
    expect(AGENT_HUB_TIP_ALLOWED_KEYS).toEqual(['feeds', 'conversationId']);
  });
});

describe('agent hub live tips settings', () => {
  it('defaults off when stored settings are invalid', () => {
    expect(parseAgentHubLiveTipsSettings({ enabled: true }).enabled).toBe(true);
    expect(parseAgentHubLiveTipsSettings({ enabled: 'yes' }).enabled).toBe(false);
    expect(parseAgentHubLiveTipsSettings(null).enabled).toBe(false);
    expect(parseAgentHubLiveTipsSettings({ extra: true }).enabled).toBe(false);
  });
});

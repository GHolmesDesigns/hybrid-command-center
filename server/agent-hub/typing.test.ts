/**
 * Ephemeral thread typing registry (LC-P5 / #675).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_HUB_TYPING_TTL_MS } from '../../shared/agent-hub-live.ts';
import { AgentHubTypingRegistry } from './typing.ts';

describe('AgentHubTypingRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts active typing with an expiry and clears on stop', () => {
    const now = 1_700_000_000_000;
    const broadcasts: unknown[] = [];
    const registry = new AgentHubTypingRegistry({ now: () => now });
    registry.attachBroadcast((_conversationId, frame) => broadcasts.push(frame));

    const active = registry.setTyping('conv-1', 'reviewer', true);
    expect(active).toMatchObject({
      kind: 'typing',
      conversationId: 'conv-1',
      agentLabel: 'reviewer',
      active: true,
      expiresAt: new Date(now + AGENT_HUB_TYPING_TTL_MS).toISOString(),
    });
    expect(broadcasts).toHaveLength(1);

    const stopped = registry.setTyping('conv-1', 'reviewer', false);
    expect(stopped).toMatchObject({ active: false, expiresAt: null });
    expect(broadcasts).toHaveLength(2);
  });

  it('expires stale typing signals after the TTL', () => {
    vi.useFakeTimers();
    let now = 1_700_000_000_000;
    const broadcasts: unknown[] = [];
    const registry = new AgentHubTypingRegistry({ now: () => now });
    registry.attachBroadcast((_conversationId, frame) => broadcasts.push(frame));

    registry.setTyping('conv-1', 'planner', true);
    broadcasts.length = 0;
    now += AGENT_HUB_TYPING_TTL_MS + 300;
    vi.advanceTimersByTime(300);

    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        kind: 'typing',
        agentLabel: 'planner',
        active: false,
      }),
    );
  });

  it('clears every conversation when an agent disconnects', () => {
    const broadcasts: unknown[] = [];
    const registry = new AgentHubTypingRegistry();
    registry.attachBroadcast((_conversationId, frame) => broadcasts.push(frame));
    registry.setTyping('conv-a', 'reviewer', true);
    registry.setTyping('conv-b', 'reviewer', true);
    broadcasts.length = 0;

    registry.clearForAgent('reviewer');
    expect(broadcasts).toEqual([
      expect.objectContaining({ conversationId: 'conv-a', agentLabel: 'reviewer', active: false }),
      expect.objectContaining({ conversationId: 'conv-b', agentLabel: 'reviewer', active: false }),
    ]);
  });
});

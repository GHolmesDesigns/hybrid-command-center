import { describe, expect, it } from 'vitest';
import {
  AgentHubTipRegistry,
  onAgentHubTip,
  resetAgentHubTipsForTests,
  setAgentHubTipBridge,
  tipAgentHubFeeds,
  tipAgentHubConversation,
  tipAgentHubNotifications,
} from './tips.ts';

describe('AgentHubTipRegistry', () => {
  it('ignores invalid payloads and survives broken listeners', () => {
    resetAgentHubTipsForTests();
    const registry = new AgentHubTipRegistry();
    setAgentHubTipBridge(registry);
    const good: unknown[] = [];
    onAgentHubTip((tip) => good.push(tip));
    registry.subscribe(() => {
      throw new Error('broken');
    });
    registry.subscribe((tip) => good.push(tip));

    registry.publish({ feeds: ['notifications'] });
    tipAgentHubNotifications();
    tipAgentHubConversation('thread-1');
    tipAgentHubFeeds([]);

    expect(good.some((tip) => JSON.stringify(tip) === JSON.stringify({ feeds: ['notifications'] }))).toBe(
      true,
    );
    expect(
      good.some(
        (tip) =>
          JSON.stringify(tip) ===
          JSON.stringify({ feeds: ['conversations'], conversationId: 'thread-1' }),
      ),
    ).toBe(true);
    expect(good.every((tip) => isTip(tip))).toBe(true);
  });

  it('drops invalid payloads at the bridge', () => {
    resetAgentHubTipsForTests();
    const registry = new AgentHubTipRegistry();
    setAgentHubTipBridge(registry);
    const seen: unknown[] = [];
    registry.subscribe((tip) => seen.push(tip));
    registry.publish({ feeds: ['notifications'], body: 'secret' } as never);
    expect(seen).toHaveLength(0);
    setAgentHubTipBridge(null);
    tipAgentHubNotifications();
    expect(seen).toHaveLength(0);
  });

  it('isolates a broken bridge from extra listeners', () => {
    resetAgentHubTipsForTests();
    setAgentHubTipBridge({
      publish: () => {
        throw new Error('bridge broken');
      },
    } as unknown as AgentHubTipRegistry);
    const seen: unknown[] = [];
    onAgentHubTip((tip) => seen.push(tip));
    tipAgentHubNotifications();
    expect(seen).toEqual([{ feeds: ['notifications'] }]);
  });
});

function isTip(value: unknown): value is { feeds: string[]; conversationId?: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { feeds?: unknown; conversationId?: unknown };
  return (
    Array.isArray(record.feeds) &&
    record.feeds.every((feed) => feed === 'conversations' || feed === 'notifications') &&
    (record.conversationId === undefined || typeof record.conversationId === 'string') &&
    !('body' in record)
  );
}

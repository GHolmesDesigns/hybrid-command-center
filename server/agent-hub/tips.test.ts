import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_HUB_TIP_ALLOWED_KEYS } from '../../shared/agent-hub-tips.ts';
import { createConversation, postMessage } from '../agent-conversations.ts';
import { notify } from '../agent-summaries.ts';
import { createDb, type Db } from '../db.ts';
import {
  AgentHubTipRegistry,
  onAgentHubTip,
  resetAgentHubTipsForTests,
  setAgentHubTipBridge,
  tipAgentHubCoordination,
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

    expect(
      good.some((tip) => JSON.stringify(tip) === JSON.stringify({ feeds: ['notifications'] })),
    ).toBe(true);
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

describe('Agent Hub tip writers', () => {
  let db: Db;

  beforeEach(() => {
    resetAgentHubTipsForTests();
    db = createDb(':memory:');
  });

  afterEach(() => {
    resetAgentHubTipsForTests();
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  it('fans out tip payloads with feeds only when conversations and notifications change', () => {
    const tips: unknown[] = [];
    onAgentHubTip((tip) => tips.push(tip));

    const conversation = createConversation(
      db,
      { title: 'Thread', scope: { type: 'freeform', id: null }, participantLabels: [] },
      'operator',
      new Date('2026-09-08T12:00:00.000Z'),
    );
    postMessage(db, conversation.id, 'operator', 'Hello', new Date('2026-09-08T12:01:00.000Z'));
    notify(db, {
      incidentKey: 'test:one',
      kind: 'memory',
      agentLabel: 'operator',
      title: 'Review memory',
      body: 'A suggested memory is waiting.',
    });

    expect(tips.length).toBeGreaterThanOrEqual(3);
    for (const tip of tips) {
      for (const key of Object.keys(tip as object)) {
        expect(AGENT_HUB_TIP_ALLOWED_KEYS as readonly string[]).toContain(key);
      }
      expect((tip as { feeds: string[] }).feeds.every((feed) => feed !== 'body')).toBe(true);
    }
    expect(tips.some((tip) => (tip as { feeds: string[] }).feeds.includes('conversations'))).toBe(
      true,
    );
    expect(tips.some((tip) => (tip as { feeds: string[] }).feeds.includes('notifications'))).toBe(
      true,
    );
    tipAgentHubCoordination();
    expect(tips.some((tip) => (tip as { feeds: string[] }).feeds.includes('coordination'))).toBe(
      true,
    );
    const messageTip = tips.find(
      (tip) =>
        (tip as { feeds: string[] }).feeds.includes('conversations') &&
        (tip as { conversationId?: string }).conversationId === conversation.id,
    );
    expect(messageTip).toBeTruthy();
  });
});

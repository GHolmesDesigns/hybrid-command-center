/**
 * Agent Hub shell SSE tip channel (C219 / #605).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { createConversation, postMessage } from '../agent-conversations.ts';
import { notify } from '../agent-summaries.ts';
import { AGENT_HUB_TIP_ALLOWED_KEYS } from '../../shared/agent-hub-sse.ts';
import {
  AgentHubTipRegistry,
  onAgentHubTip,
  resetAgentHubTipsForTests,
  setAgentHubTipBridge,
  tipAgentHubConversation,
  tipAgentHubCoordination,
} from './tips.ts';
import { handleAgentHubTipsGet } from './sse-route.ts';

describe('Agent Hub SSE tips (C219)', () => {
  let db: Db;
  let app: Express;

  beforeEach(() => {
    resetAgentHubTipsForTests();
    db = createDb(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    resetAgentHubTipsForTests();
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  it('refuses non-SSE Accept headers', async () => {
    const res = await request(app).get('/api/agent-hub/tips').set('Accept', 'application/json');
    expect(res.status).toBe(406);
  });

  it('fans out tip payloads with feeds only when conversations and notifications change', async () => {
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

  it('writes SSE frames to a live subscriber', () => {
    const registry = new AgentHubTipRegistry();
    const chunks: string[] = [];
    const res = {
      writableEnded: false,
      setHeader() {
        return this;
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      on() {
        return this;
      },
      flushHeaders() {},
    };
    const req = {
      headers: { accept: 'text/event-stream' },
      on() {},
    };

    setAgentHubTipBridge(registry);
    handleAgentHubTipsGet(req as never, res as never, registry);
    tipAgentHubConversation('conv-live');

    const payload = chunks.join('');
    expect(payload).toContain(': connected');
    expect(payload).toContain('"feeds":["conversations"]');
    expect(payload).toContain('"conversationId":"conv-live"');
    expect(payload).not.toContain('Ping');
  });

  it('unsubscribes when the client disconnects', () => {
    const registry = new AgentHubTipRegistry();
    setAgentHubTipBridge(registry);
    let closeRequest: (() => void) | undefined;
    const req = {
      headers: { accept: 'text/event-stream' },
      on(event: string, listener: () => void) {
        if (event === 'close') closeRequest = listener;
      },
    };
    const chunks: string[] = [];
    const res = {
      writableEnded: false,
      setHeader() {
        return this;
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      on() {
        return this;
      },
      flushHeaders() {},
    };

    handleAgentHubTipsGet(req as never, res as never, registry);
    tipAgentHubConversation('before-close');
    expect(chunks.some((chunk) => chunk.includes('before-close'))).toBe(true);
    closeRequest?.();
    tipAgentHubConversation('after-close');
    expect(chunks.some((chunk) => chunk.includes('after-close'))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from '../db.ts';
import { createAssistantMcpAgentCredential } from '../auth/mcp-agent-credentials.ts';
import { setSetting } from '../drive/service.ts';
import {
  COMMAND_AI_ASSISTANT_SETTING_KEY,
  DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS,
} from '../../shared/command-ai-assistant.ts';
import { storeKey } from './keys.ts';

const SECRET = 'test-assistant-encryption-key-32chars!';

describe('command ai assistant routes', () => {
  let db: Db;
  let createApp: typeof import('../app.ts').createApp;

  beforeEach(async () => {
    process.env.ASSISTANT_KEY_ENCRYPTION_KEY = SECRET;
    process.env.HCC_ASSISTANT_PROVIDER = 'stub';
    vi.resetModules();
    ({ createApp } = await import('../app.ts'));
    db = createDb(':memory:');
    storeKey(db, 'openai', 'sk-test-key-1234567890', SECRET);
    setSetting(
      db,
      COMMAND_AI_ASSISTANT_SETTING_KEY,
      JSON.stringify({ ...DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS, enabled: true }),
    );
    createAssistantMcpAgentCredential(db, {
      scopes: ['workspace:read', 'workspace:write'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      sessionSecret: 'test-session-secret-at-least-32-chars!',
    });
  });

  afterEach(() => {
    delete process.env.ASSISTANT_KEY_ENCRYPTION_KEY;
    delete process.env.HCC_ASSISTANT_PROVIDER;
    vi.resetModules();
    db.close();
  });

  it('updates assistant settings and enforces cap lowering', async () => {
    const app = createApp(db);
    const saved = await request(app)
      .put('/api/settings/command-ai-assistant')
      .send({ dailyTurnCap: 50, provider: 'anthropic' })
      .expect(200);
    expect(saved.body.assistant.dailyTurnCap).toBe(50);
    expect(saved.body.assistant.provider).toBe('anthropic');
    expect(
      (await request(app).put('/api/settings/command-ai-assistant').send({ dailyTurnCap: 200 }))
        .status,
    ).toBe(400);
  });

  it('returns assistant settings metadata without exposing keys', async () => {
    const app = createApp(db);
    const response = await request(app).get('/api/settings/command-ai-assistant').expect(200);
    expect(response.body.assistant.enabled).toBe(true);
    expect(response.body.key).toEqual({ provider: 'openai', hasKey: true, keyLast4: '7890' });
    expect(response.body.ready).toBe(true);
  });

  it('starts a stub turn from an operator message and persists an assistant reply', async () => {
    const app = createApp(db);
    const conversation = await request(app)
      .post('/api/agent-conversations')
      .send({ title: 'Route turn', scope: { type: 'freeform' } })
      .expect(201);
    await request(app)
      .post(`/api/agent-conversations/${conversation.body.id}/messages`)
      .send({ body: 'Hello assistant' })
      .expect(201);
    await vi.waitFor(async () => {
      const messages = await request(app)
        .get(`/api/agent-conversations/${conversation.body.id}/messages`)
        .expect(200);
      expect(
        messages.body.items.some((m: { senderKind: string }) => m.senderKind === 'assistant'),
      ).toBe(true);
    });
    const turn = await request(app)
      .get(`/api/agent-conversations/${conversation.body.id}/assistant/turn`)
      .expect(200);
    expect(turn.body.turn?.state).toBe('awaiting_approval');
    const approvals = await request(app)
      .get(`/api/agent-conversations/${conversation.body.id}/assistant/approvals`)
      .expect(200);
    expect(approvals.body.approvals).toHaveLength(1);

    const approvalId = approvals.body.approvals[0].id as string;
    const declined = await request(app)
      .post(
        `/api/agent-conversations/${conversation.body.id}/assistant/approvals/${approvalId}/respond`,
      )
      .send({ approved: false })
      .expect(200);
    expect(declined.body.approval.status).toBe('declined');
  });

  it('cancels an in-progress assistant turn', async () => {
    const app = createApp(db);
    const conversation = await request(app)
      .post('/api/agent-conversations')
      .send({ title: 'Cancel route', scope: { type: 'freeform' } })
      .expect(201);
    await request(app)
      .post(`/api/agent-conversations/${conversation.body.id}/messages`)
      .send({ body: 'Please wait' })
      .expect(201);
    await vi.waitFor(async () => {
      const turn = await request(app)
        .get(`/api/agent-conversations/${conversation.body.id}/assistant/turn`)
        .expect(200);
      expect(turn.body.turn).toBeTruthy();
    });
    const cancelled = await request(app)
      .post(`/api/agent-conversations/${conversation.body.id}/assistant/cancel`)
      .expect(200);
    expect(cancelled.body.ok).toBe(true);
    const turn = await request(app)
      .get(`/api/agent-conversations/${conversation.body.id}/assistant/turn`)
      .expect(200);
    expect(turn.body.turn == null || turn.body.turn.state === 'cancelled').toBe(true);
  });

  it('approves an inline write through the HTTP approval endpoint', async () => {
    const app = createApp(db);
    const conversation = await request(app)
      .post('/api/agent-conversations')
      .send({ title: 'Approve route', scope: { type: 'freeform' } })
      .expect(201);
    await request(app)
      .post(`/api/agent-conversations/${conversation.body.id}/messages`)
      .send({ body: 'Add checklist item' })
      .expect(201);
    await vi.waitFor(async () => {
      const approvals = await request(app)
        .get(`/api/agent-conversations/${conversation.body.id}/assistant/approvals`)
        .expect(200);
      expect(approvals.body.approvals).toHaveLength(1);
    });
    const approvalId = (
      await request(app)
        .get(`/api/agent-conversations/${conversation.body.id}/assistant/approvals`)
        .expect(200)
    ).body.approvals[0].id as string;
    const approved = await request(app)
      .post(
        `/api/agent-conversations/${conversation.body.id}/assistant/approvals/${approvalId}/respond`,
      )
      .send({ approved: true })
      .expect(200);
    expect(approved.body.approval.status).toBe('approved');
    expect(
      (await request(app).get(`/api/agent-conversations/${conversation.body.id}/assistant/turn`))
        .body.turn,
    ).toBeNull();
  });

  it('returns null turn state when no assistant turn is active', async () => {
    const app = createApp(db);
    const conversation = await request(app)
      .post('/api/agent-conversations')
      .send({ title: 'Idle', scope: { type: 'freeform' } })
      .expect(201);
    const turn = await request(app)
      .get(`/api/agent-conversations/${conversation.body.id}/assistant/turn`)
      .expect(200);
    expect(turn.body.turn).toBeNull();
    expect(
      (
        await request(app).get(
          `/api/agent-conversations/${conversation.body.id}/assistant/approvals`,
        )
      ).body.approvals,
    ).toEqual([]);
  });

  it('rejects assistant settings that clear every scope', async () => {
    const app = createApp(db);
    await request(app).put('/api/settings/command-ai-assistant').send({ scopes: [] }).expect(400);
  });

  it('returns 404 for assistant routes on unknown conversations', async () => {
    const app = createApp(db);
    await request(app).get('/api/agent-conversations/missing/assistant/turn').expect(404);
    await request(app).post('/api/agent-conversations/missing/assistant/cancel').expect(404);
  });

  it('stores provider keys without returning them', async () => {
    const app = createApp(db);
    const saved = await request(app)
      .put('/api/settings/command-ai-assistant/key')
      .send({ provider: 'anthropic', key: 'sk-ant-test-key-1234567890' })
      .expect(200);
    expect(saved.body.key).toEqual({
      provider: 'anthropic',
      hasKey: true,
      keyLast4: '7890',
    });
  });
});

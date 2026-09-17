import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversation, listMessages, postMessage } from '../agent-conversations.ts';
import { createAssistantMcpAgentCredential } from '../auth/mcp-agent-credentials.ts';
import { setSetting } from '../drive/service.ts';
import {
  COMMAND_AI_ASSISTANT_SETTING_KEY,
  DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS,
} from '../../shared/command-ai-assistant.ts';
import type { Db } from '../db.ts';

const SECRET = 'test-assistant-encryption-key-32chars!';

describe('assistant service', () => {
  let db: Db;
  let startTurnAfterOperatorMessage: typeof import('./service.ts').startTurnAfterOperatorMessage;
  let storeKey: typeof import('./keys.ts').storeKey;

  beforeEach(async () => {
    process.env.ASSISTANT_KEY_ENCRYPTION_KEY = SECRET;
    vi.resetModules();
    const [{ createDb }, keys, service] = await Promise.all([
      import('../db.ts'),
      import('./keys.ts'),
      import('./service.ts'),
    ]);
    db = createDb(':memory:');
    storeKey = keys.storeKey;
    startTurnAfterOperatorMessage = service.startTurnAfterOperatorMessage;
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
    vi.resetModules();
    db.close();
  });

  it('queues a stub turn after an operator message when the assistant is ready', async () => {
    const conversation = createConversation(
      db,
      { title: 'Queue', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
    );
    postMessage(db, conversation.id, 'operator', 'Start turn');
    startTurnAfterOperatorMessage(db, conversation.id, {
      operatorSessionHash: 'session-hash',
      encryptionSecret: SECRET,
      stubMode: true,
      stubOptions: { proposeTool: false },
    });
    await vi.waitFor(() => {
      const messages = listMessages(db, conversation.id, 'operator').items;
      expect(messages.some((m) => m.senderKind === 'assistant')).toBe(true);
    });
  });

  it('does not queue a turn when the assistant is disabled', async () => {
    setSetting(
      db,
      COMMAND_AI_ASSISTANT_SETTING_KEY,
      JSON.stringify({ ...DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS, enabled: false }),
    );
    const conversation = createConversation(
      db,
      { title: 'Disabled', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
    );
    postMessage(db, conversation.id, 'operator', 'No turn');
    startTurnAfterOperatorMessage(db, conversation.id, {
      operatorSessionHash: 'session-hash',
      encryptionSecret: SECRET,
      stubMode: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      listMessages(db, conversation.id, 'operator').items.some((m) => m.senderKind === 'assistant'),
    ).toBe(false);
  });

  it('ignores duplicate queue requests for the same conversation', async () => {
    const conversation = createConversation(
      db,
      { title: 'Dedup', scope: { type: 'freeform' }, participantLabels: [] },
      'operator',
    );
    const options = {
      operatorSessionHash: 'session-hash',
      encryptionSecret: SECRET,
      stubMode: true,
      stubOptions: { proposeTool: false, delayMs: 50 },
    };
    startTurnAfterOperatorMessage(db, conversation.id, options);
    startTurnAfterOperatorMessage(db, conversation.id, options);
    await vi.waitFor(() => {
      expect(
        listMessages(db, conversation.id, 'operator').items.filter((m) => m.senderKind === 'assistant'),
      ).toHaveLength(1);
    });
  });
});

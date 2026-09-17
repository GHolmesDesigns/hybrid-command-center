import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { AGENT_HUB_LIVE_TIPS_SETTING_KEY } from '../../shared/agent-hub-sse.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { COMMAND_AI_ASSISTANT_SETTING_KEY } from '../../shared/command-ai-assistant.ts';
import { storeKey } from './keys.ts';
import { readCommandAiAssistant, updateCommandAiAssistant } from './settings.ts';

const SECRET = 'test-assistant-encryption-key-32chars!';

describe('command ai assistant settings', () => {
  let db: Db;

  it('defaults off and rejects raising daily caps', () => {
    db = createDb(':memory:');
    expect(readCommandAiAssistant(db)).toMatchObject({ enabled: false, dailyTurnCap: 100 });
    expect(() => updateCommandAiAssistant(db, { dailyTurnCap: 200 })).toThrow(
      /cannot exceed the server default/i,
    );
    db.close();
  });

  afterEach(() => {
    delete process.env.ASSISTANT_KEY_ENCRYPTION_KEY;
    vi.resetModules();
  });

  it('forces live tips on when enabling the assistant', async () => {
    process.env.ASSISTANT_KEY_ENCRYPTION_KEY = SECRET;
    vi.resetModules();
    const settings = await import('./settings.ts');
    db = createDb(':memory:');
    storeKey(db, 'openai', 'sk-test-key-1234567890', SECRET);
    settings.updateCommandAiAssistant(db, { enabled: true, provider: 'openai' });
    expect(JSON.parse(getSetting(db, AGENT_HUB_LIVE_TIPS_SETTING_KEY)!)).toEqual({ enabled: true });
    expect(settings.assistantReady(db)).toBe(true);
    db.close();
  });

  it('leaves live tips unchanged when disabling the assistant', () => {
    db = createDb(':memory:');
    updateCommandAiAssistant(db, { enabled: false });
    expect(getSetting(db, AGENT_HUB_LIVE_TIPS_SETTING_KEY)).toBeUndefined();
    db.close();
  });

  it('rejects token cap raises and enabling without a stored key', async () => {
    process.env.ASSISTANT_KEY_ENCRYPTION_KEY = SECRET;
    vi.resetModules();
    const settings = await import('./settings.ts');
    db = createDb(':memory:');
    expect(() => settings.updateCommandAiAssistant(db, { dailyTokenCap: 400_000 })).toThrow(
      /token cap cannot exceed/i,
    );
    expect(() => settings.updateCommandAiAssistant(db, { enabled: true })).toThrow(
      /add an api key/i,
    );
    db.close();
  });

  it('normalizes an invalid model for the selected provider', () => {
    db = createDb(':memory:');
    updateCommandAiAssistant(db, { provider: 'anthropic', model: 'gpt-4o-mini' });
    expect(readCommandAiAssistant(db).model).toBe('claude-sonnet-4-20250514');
    db.close();
  });

  it('reports assistant readiness from stub mode without a stored key', async () => {
    process.env.HCC_ASSISTANT_PROVIDER = 'stub';
    vi.resetModules();
    const settings = await import('./settings.ts');
    db = createDb(':memory:');
    settings.updateCommandAiAssistant(db, { enabled: true, provider: 'openai' });
    expect(settings.assistantReady(db)).toBe(true);
    delete process.env.HCC_ASSISTANT_PROVIDER;
    db.close();
  });

  it('falls back to defaults when stored settings are invalid JSON', () => {
    db = createDb(':memory:');
    setSetting(db, COMMAND_AI_ASSISTANT_SETTING_KEY, '{not-json');
    expect(readCommandAiAssistant(db).enabled).toBe(false);
    db.close();
  });

  it('reports not ready when enabled without an encryption key configured', async () => {
    delete process.env.ASSISTANT_KEY_ENCRYPTION_KEY;
    vi.resetModules();
    const settings = await import('./settings.ts');
    db = createDb(':memory:');
    storeKey(db, 'openai', 'sk-test-key-1234567890', SECRET);
    setSetting(
      db,
      COMMAND_AI_ASSISTANT_SETTING_KEY,
      JSON.stringify({ enabled: true, provider: 'openai' }),
    );
    expect(settings.assistantReady(db)).toBe(false);
    db.close();
  });
});

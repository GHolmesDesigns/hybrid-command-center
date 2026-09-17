import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db.ts';
import { storeKey } from '../keys.ts';
import { resolveProvider } from './index.ts';

const SECRET = 'assistant-key-secret-at-least-thirty-two';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('resolveProvider', () => {
  it('returns the stub provider when stub mode is requested', async () => {
    const provider = resolveProvider({
      db,
      provider: 'openai',
      encryptionSecret: SECRET,
      stubMode: true,
    });
    const result = await provider.streamTurn({
      model: 'gpt-4o-mini',
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxOutputTokens: 100,
    });
    expect(result.text).toContain('Command AI');
  });

  it('throws when a live provider is requested without a stored key', () => {
    expect(() =>
      resolveProvider({ db, provider: 'openai', encryptionSecret: SECRET }),
    ).toThrow(/no api key/i);
  });

  it('returns provider adapters when keys are stored', () => {
    storeKey(db, 'openai', 'sk-openai-test-key-1234567890', SECRET);
    storeKey(db, 'anthropic', 'sk-ant-test-key-1234567890', SECRET);
    expect(typeof resolveProvider({ db, provider: 'openai', encryptionSecret: SECRET }).streamTurn).toBe(
      'function',
    );
    expect(
      typeof resolveProvider({ db, provider: 'anthropic', encryptionSecret: SECRET }).streamTurn,
    ).toBe('function');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { hasKeyForProvider, readDecryptedKey, readKeyMetadata, storeKey } from './keys.ts';

const SECRET = 'assistant-key-secret-at-least-thirty-two';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('assistant provider keys', () => {
  it('stores metadata without returning the raw key', () => {
    const meta = storeKey(db, 'openai', 'sk-openai-test-key-1234567890', SECRET);
    expect(meta).toEqual({ provider: 'openai', hasKey: true, keyLast4: '7890' });
    expect(readKeyMetadata(db, 'openai')).toEqual(meta);
    expect(hasKeyForProvider(db, 'openai')).toBe(true);
    expect(readDecryptedKey(db, 'openai', SECRET)).toBe('sk-openai-test-key-1234567890');
  });

  it('reports missing keys and refuses empty input', () => {
    expect(readKeyMetadata(db, 'anthropic')).toEqual({
      provider: 'anthropic',
      hasKey: false,
      keyLast4: null,
    });
    expect(() => storeKey(db, 'openai', '   ', SECRET)).toThrow(/required/i);
  });

  it('returns null when decryption fails or secret is missing', () => {
    storeKey(db, 'openai', 'sk-openai-test-key-1234567890', SECRET);
    expect(readDecryptedKey(db, 'openai', '')).toBeNull();
    db.prepare('UPDATE assistant_provider_keys SET encrypted_key=? WHERE provider=?').run(
      'not-valid-ciphertext',
      'openai',
    );
    expect(readDecryptedKey(db, 'openai', SECRET)).toBeNull();
  });
});

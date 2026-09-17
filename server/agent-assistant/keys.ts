import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { encryptJson, decryptJson } from '../drive/tokens.ts';
import type { AssistantProviderName } from '../../shared/command-ai-assistant.ts';
import {
  assistantKeyMetadataSchema,
  type AssistantKeyMetadata,
} from '../../shared/command-ai-assistant.ts';

type KeyRow = {
  provider: string;
  encrypted_key: string;
  key_last4: string;
  updated_at: string;
};

const SELECT_KEY = `SELECT provider, encrypted_key, key_last4, updated_at FROM assistant_provider_keys`;

export function storeKey(
  db: Db,
  provider: AssistantProviderName,
  rawKey: string,
  encryptionSecret: string,
  now = new Date(),
): AssistantKeyMetadata {
  const trimmed = rawKey.trim();
  if (!trimmed) throw Object.assign(new Error('API key is required.'), { status: 400 });
  const keyLast4 = trimmed.slice(-4);
  const encrypted = encryptJson({ key: trimmed }, encryptionSecret);
  const at = now.toISOString();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO assistant_provider_keys(provider, encrypted_key, key_last4, updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(provider) DO UPDATE SET
         encrypted_key=excluded.encrypted_key,
         key_last4=excluded.key_last4,
         updated_at=excluded.updated_at`,
    ).run(provider, encrypted, keyLast4, at);
  });
  return { provider, hasKey: true, keyLast4 };
}

export function readKeyMetadata(
  db: Db,
  provider: AssistantProviderName,
): AssistantKeyMetadata {
  const row = db.prepare(`${SELECT_KEY} WHERE provider=?`).get(provider) as KeyRow | undefined;
  if (!row) return assistantKeyMetadataSchema.parse({ provider, hasKey: false, keyLast4: null });
  return assistantKeyMetadataSchema.parse({
    provider,
    hasKey: true,
    keyLast4: row.key_last4,
  });
}

export function hasKeyForProvider(db: Db, provider: AssistantProviderName): boolean {
  return !!db.prepare('SELECT 1 FROM assistant_provider_keys WHERE provider=?').get(provider);
}

/** Decrypts the stored key for server-side provider calls only — never expose to HTTP. */
export function readDecryptedKey(
  db: Db,
  provider: AssistantProviderName,
  encryptionSecret: string,
): string | null {
  const row = db.prepare(`${SELECT_KEY} WHERE provider=?`).get(provider) as KeyRow | undefined;
  if (!row?.encrypted_key || !encryptionSecret) return null;
  try {
    const payload = decryptJson(row.encrypted_key, encryptionSecret) as { key?: string };
    return typeof payload.key === 'string' && payload.key.trim() ? payload.key.trim() : null;
  } catch {
    return null;
  }
}

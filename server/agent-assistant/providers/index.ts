import type { AssistantProviderName } from '../../../shared/command-ai-assistant.ts';
import type { Db } from '../../db.ts';
import { readDecryptedKey } from '../keys.ts';
import { createAnthropicAssistantProvider } from './anthropic.ts';
import { createOpenAiAssistantProvider } from './openai.ts';
import { createStubAssistantProvider, type StubAssistantOptions } from './stub.ts';
import type { AssistantProvider } from './types.ts';

export type ResolveProviderOptions = {
  db: Db;
  provider: AssistantProviderName;
  encryptionSecret: string;
  stubMode?: boolean;
  stubOptions?: StubAssistantOptions;
};

export function resolveProvider(options: ResolveProviderOptions): AssistantProvider {
  if (options.stubMode) return createStubAssistantProvider(options.stubOptions);
  const apiKey = readDecryptedKey(options.db, options.provider, options.encryptionSecret);
  if (!apiKey) throw new Error(`No API key stored for provider ${options.provider}.`);
  if (options.provider === 'anthropic') return createAnthropicAssistantProvider(apiKey);
  return createOpenAiAssistantProvider(apiKey);
}

import type { Db } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { assistantKeyEncryptionKey, assistantStubMode, config } from '../config.ts';
import { updateAgentHubLiveTips } from '../agent-hub/settings.ts';
import {
  COMMAND_AI_ASSISTANT_SETTING_KEY,
  DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS,
  commandAiAssistantSettingsInputSchema,
  commandAiAssistantSettingsSchema,
  isAssistantModelForProvider,
  normalizeAssistantModel,
  type CommandAiAssistantSettings,
} from '../../shared/command-ai-assistant.ts';
import { hasKeyForProvider } from './keys.ts';

export function readCommandAiAssistant(db: Db): CommandAiAssistantSettings {
  const raw = getSetting(db, COMMAND_AI_ASSISTANT_SETTING_KEY);
  if (!raw) return { ...DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS };
  try {
    const parsed = commandAiAssistantSettingsSchema.parse(JSON.parse(raw));
    return {
      ...parsed,
      model: normalizeAssistantModel(parsed.provider, parsed.model),
    };
  } catch {
    return { ...DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS };
  }
}

function assertEncryptionKeyWhenEnabling(enabled: boolean): void {
  if (!enabled || assistantStubMode()) return;
  const key = assistantKeyEncryptionKey();
  if (!key || key.length < 32) {
    throw Object.assign(
      new Error(
        'ASSISTANT_KEY_ENCRYPTION_KEY must be at least 32 characters before enabling the Command AI assistant.',
      ),
      { status: 400 },
    );
  }
}

function assertCapLowering(next: CommandAiAssistantSettings): void {
  if (next.dailyTurnCap > DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS.dailyTurnCap) {
    throw Object.assign(
      new Error(
        `Daily turn cap cannot exceed the server default of ${DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS.dailyTurnCap}.`,
      ),
      { status: 400 },
    );
  }
  if (next.dailyTokenCap > DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS.dailyTokenCap) {
    throw Object.assign(
      new Error(
        `Daily token cap cannot exceed the server default of ${DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS.dailyTokenCap}.`,
      ),
      { status: 400 },
    );
  }
}

export function updateCommandAiAssistant(
  db: Db,
  raw: unknown,
): { assistant: CommandAiAssistantSettings } {
  const input = commandAiAssistantSettingsInputSchema.parse(raw);
  const current = readCommandAiAssistant(db);
  const merged: CommandAiAssistantSettings = commandAiAssistantSettingsSchema.parse({
    ...current,
    ...input,
    model: input.model
      ? normalizeAssistantModel(input.provider ?? current.provider, input.model)
      : current.model,
    provider: input.provider ?? current.provider,
  });
  if (!isAssistantModelForProvider(merged.provider, merged.model)) {
    merged.model = normalizeAssistantModel(merged.provider, merged.model);
  }
  assertCapLowering(merged);
  assertEncryptionKeyWhenEnabling(merged.enabled);
  if (merged.enabled && !assistantStubMode() && !hasKeyForProvider(db, merged.provider)) {
    throw Object.assign(
      new Error(`Add an API key for ${merged.provider} before enabling the assistant.`),
      { status: 400 },
    );
  }
  setSetting(db, COMMAND_AI_ASSISTANT_SETTING_KEY, JSON.stringify(merged));
  if (merged.enabled) {
    updateAgentHubLiveTips(db, { enabled: true });
  }
  return { assistant: merged };
}

/** Whether the assistant can run a turn for the configured provider. */
export function assistantReady(db: Db): boolean {
  const settings = readCommandAiAssistant(db);
  if (!settings.enabled) return false;
  if (assistantStubMode()) return true;
  if (!assistantKeyEncryptionKey()) return false;
  return hasKeyForProvider(db, settings.provider);
}

/** Test helper — encryption secret from config. */
export function assistantEncryptionSecret(): string {
  return assistantKeyEncryptionKey() || config.google.encryptionKey || 'test-assistant-key-32-chars-min!!';
}

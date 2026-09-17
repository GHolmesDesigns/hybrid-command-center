import { z } from 'zod';
import { ASSISTANT_AGENT_LABEL, mcpAgentScopeSchema } from './mcp-agent-registry.ts';

export { ASSISTANT_AGENT_LABEL };

export const COMMAND_AI_ASSISTANT_SETTING_KEY = 'command_ai_assistant';

export const ASSISTANT_PROVIDERS = ['openai', 'anthropic'] as const;
export type AssistantProviderName = (typeof ASSISTANT_PROVIDERS)[number];

export const OPENAI_ASSISTANT_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
] as const;

export const ANTHROPIC_ASSISTANT_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
] as const;

export type OpenAiAssistantModel = (typeof OPENAI_ASSISTANT_MODELS)[number];
export type AnthropicAssistantModel = (typeof ANTHROPIC_ASSISTANT_MODELS)[number];

export const ASSISTANT_MODELS_BY_PROVIDER: Record<AssistantProviderName, readonly string[]> = {
  openai: OPENAI_ASSISTANT_MODELS,
  anthropic: ANTHROPIC_ASSISTANT_MODELS,
};

/** Provider/model output-token ceiling for complex runs. */
export const MODEL_OUTPUT_TOKEN_CEILING: Record<string, number> = {
  'gpt-4o': 16_384,
  'gpt-4o-mini': 16_384,
  'gpt-4.1': 32_768,
  'gpt-4.1-mini': 32_768,
  'claude-sonnet-4-20250514': 8_192,
  'claude-3-5-sonnet-20241022': 8_192,
  'claude-3-5-haiku-20241022': 8_192,
};

export const DEFAULT_DAILY_TURN_CAP = 100;
export const DEFAULT_DAILY_TOKEN_CAP = 300_000;

export const LIGHT_TOUCH_LIMITS = {
  maxToolCalls: 3,
  wallClockMs: 60_000,
  maxOutputTokens: 2_000,
} as const;

export const COMPLEX_LIMITS = {
  maxToolCalls: 12,
  wallClockMs: 5 * 60_000,
} as const;

export const APPROVAL_EXPIRY_MS = 15 * 60_000;

export const assistantProviderSchema = z.enum(ASSISTANT_PROVIDERS);

export const commandAiAssistantSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: assistantProviderSchema,
  model: z.string().min(1).max(80),
  dailyTurnCap: z.number().int().min(1),
  dailyTokenCap: z.number().int().min(1_000),
  scopes: z.array(mcpAgentScopeSchema).min(1),
});

export type CommandAiAssistantSettings = z.infer<typeof commandAiAssistantSettingsSchema>;

export const DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS: CommandAiAssistantSettings = {
  enabled: false,
  provider: 'openai',
  model: OPENAI_ASSISTANT_MODELS[1],
  dailyTurnCap: DEFAULT_DAILY_TURN_CAP,
  dailyTokenCap: DEFAULT_DAILY_TOKEN_CAP,
  scopes: ['workspace:read', 'workspace:write'],
};

export const commandAiAssistantSettingsInputSchema = commandAiAssistantSettingsSchema.partial();

export const assistantKeyMetadataSchema = z.object({
  provider: assistantProviderSchema,
  hasKey: z.boolean(),
  keyLast4: z.string().max(4).nullable(),
});

export type AssistantKeyMetadata = z.infer<typeof assistantKeyMetadataSchema>;

export const assistantPendingApprovalSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  turnId: z.string(),
  toolName: z.string(),
  toolArgs: z.record(z.string(), z.unknown()),
  tier: z.enum(['blocking', 'inline']),
  summary: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(['pending', 'approved', 'declined', 'expired', 'withdrawn']),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
});

export type AssistantPendingApproval = z.infer<typeof assistantPendingApprovalSchema>;

export const ASSISTANT_TURN_STATES = [
  'running',
  'awaiting_approval',
  'finished',
  'failed',
  'cancelled',
] as const;

export type AssistantTurnStateKind = (typeof ASSISTANT_TURN_STATES)[number];

export const assistantTurnStateSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  state: z.enum(ASSISTANT_TURN_STATES),
  profile: z.enum(['light', 'complex']),
  toolCallCount: z.number().int().nonnegative(),
  outputTokenCount: z.number().int().nonnegative(),
  startedAt: z.string(),
  updatedAt: z.string(),
  cancelRequested: z.boolean(),
  pendingApprovalIds: z.array(z.string()),
});

export type AssistantTurnState = z.infer<typeof assistantTurnStateSchema>;

export const storeAssistantKeyInputSchema = z.object({
  provider: assistantProviderSchema,
  key: z.string().min(8).max(512),
});

export function modelOutputTokenCeiling(model: string): number {
  return MODEL_OUTPUT_TOKEN_CEILING[model] ?? LIGHT_TOUCH_LIMITS.maxOutputTokens;
}

export function isAssistantModelForProvider(
  provider: AssistantProviderName,
  model: string,
): boolean {
  return (ASSISTANT_MODELS_BY_PROVIDER[provider] as readonly string[]).includes(model);
}

export function normalizeAssistantModel(provider: AssistantProviderName, model: string): string {
  const list = ASSISTANT_MODELS_BY_PROVIDER[provider];
  if ((list as readonly string[]).includes(model)) return model;
  return list[0]!;
}

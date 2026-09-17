import { describe, expect, it } from 'vitest';
import {
  APPROVAL_EXPIRY_MS,
  ASSISTANT_MODELS_BY_PROVIDER,
  commandAiAssistantSettingsSchema,
  DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS,
  DEFAULT_DAILY_TOKEN_CAP,
  DEFAULT_DAILY_TURN_CAP,
  isAssistantModelForProvider,
  LIGHT_TOUCH_LIMITS,
  modelOutputTokenCeiling,
  normalizeAssistantModel,
  storeAssistantKeyInputSchema,
  assistantKeyMetadataSchema,
  assistantPendingApprovalSchema,
  assistantTurnStateSchema,
} from './command-ai-assistant.ts';

describe('command-ai-assistant shared helpers', () => {
  it('exposes planning defaults for daily caps and light-touch limits', () => {
    expect(DEFAULT_DAILY_TURN_CAP).toBe(100);
    expect(DEFAULT_DAILY_TOKEN_CAP).toBe(300_000);
    expect(LIGHT_TOUCH_LIMITS.maxToolCalls).toBe(3);
    expect(APPROVAL_EXPIRY_MS).toBe(15 * 60_000);
  });

  it('returns a model ceiling or falls back to the light-touch output cap', () => {
    expect(modelOutputTokenCeiling('gpt-4o-mini')).toBeGreaterThan(
      LIGHT_TOUCH_LIMITS.maxOutputTokens,
    );
    expect(modelOutputTokenCeiling('unknown-model')).toBe(LIGHT_TOUCH_LIMITS.maxOutputTokens);
  });

  it('validates assistant models per provider', () => {
    const openAiModel = ASSISTANT_MODELS_BY_PROVIDER.openai[0]!;
    expect(isAssistantModelForProvider('openai', openAiModel)).toBe(true);
    expect(isAssistantModelForProvider('openai', 'not-a-model')).toBe(false);
    expect(isAssistantModelForProvider('anthropic', openAiModel)).toBe(false);
  });

  it('normalizes unknown models to the provider default', () => {
    const defaultOpenAi = ASSISTANT_MODELS_BY_PROVIDER.openai[0]!;
    expect(normalizeAssistantModel('openai', defaultOpenAi)).toBe(defaultOpenAi);
    expect(normalizeAssistantModel('openai', 'bogus')).toBe(defaultOpenAi);
  });

  it('parses partial settings updates from the API boundary', () => {
    expect(
      commandAiAssistantSettingsSchema.parse({
        ...DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS,
        dailyTurnCap: 75,
      }).dailyTurnCap,
    ).toBe(75);
  });

  it('parses settings, key storage, approvals, and turn state payloads', () => {
    expect(commandAiAssistantSettingsSchema.parse(DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS)).toEqual(
      DEFAULT_COMMAND_AI_ASSISTANT_SETTINGS,
    );
    expect(
      storeAssistantKeyInputSchema.parse({ provider: 'openai', key: 'sk-test-key' }).provider,
    ).toBe('openai');
    expect(
      assistantKeyMetadataSchema.parse({ provider: 'anthropic', hasKey: true, keyLast4: '1234' })
        .hasKey,
    ).toBe(true);
    expect(
      assistantPendingApprovalSchema.parse({
        id: 'a1',
        conversationId: 'c1',
        turnId: 't1',
        toolName: 'workspace_update_task',
        toolArgs: { taskId: 'task-1' },
        tier: 'inline',
        summary: { targetName: 'Task', targetId: 'task-1' },
        status: 'pending',
        createdAt: '2026-09-17T12:00:00.000Z',
        expiresAt: '2026-09-17T12:15:00.000Z',
        decidedAt: null,
      }).tier,
    ).toBe('inline');
    expect(
      assistantTurnStateSchema.parse({
        conversationId: 'c1',
        turnId: 't1',
        state: 'running',
        profile: 'light',
        toolCallCount: 0,
        outputTokenCount: 0,
        startedAt: '2026-09-17T12:00:00.000Z',
        updatedAt: '2026-09-17T12:00:00.000Z',
        cancelRequested: false,
        pendingApprovalIds: [],
      }).state,
    ).toBe('running');
  });
});

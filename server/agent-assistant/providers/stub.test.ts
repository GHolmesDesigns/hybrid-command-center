import { describe, expect, it } from 'vitest';
import { createStubAssistantProvider } from './stub.ts';

describe('stub assistant provider', () => {
  it('streams deterministic text and optional tool proposals', async () => {
    const events: string[] = [];
    const plain = await createStubAssistantProvider({ proposeTool: false }).streamTurn({
      model: 'stub',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 100,
      onEvent: (event) => events.push(event.type),
    });
    expect(plain.text).toContain('Command AI');
    expect(plain.toolCalls).toHaveLength(0);
    expect(events).toContain('text_delta');

    const withTool = await createStubAssistantProvider({
      proposeTool: true,
      toolName: 'workspace_create_task',
      toolArgs: { title: 'Draft' },
    }).streamTurn({
      model: 'stub',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'add task' }],
      tools: [],
      maxOutputTokens: 100,
    });
    expect(withTool.toolCalls[0]?.name).toBe('workspace_create_task');
  });

  it('honours abort signals while streaming', async () => {
    const controller = new AbortController();
    const provider = createStubAssistantProvider({ delayMs: 50 });
    const pending = provider.streamTurn({
      model: 'stub',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 100,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});

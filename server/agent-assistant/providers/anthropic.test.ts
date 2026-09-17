import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicAssistantProvider } from './anthropic.ts';

describe('Anthropic assistant provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a messages response into text and usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Anthropic reply.' }],
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
      })),
    );

    const provider = createAnthropicAssistantProvider('sk-ant-test');
    const result = await provider.streamTurn({
      model: 'claude-3-5-haiku-20241022',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxOutputTokens: 100,
    });

    expect(result.text).toBe('Anthropic reply.');
    expect(result.usage.inputTokens).toBe(8);
  });

  it('maps tool-use blocks and skips tool transcript rows', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [
            { type: 'text', text: 'Part one. ' },
            { type: 'text', text: 'Part two.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'workspace_list_tasks',
              input: { projectId: 'p1' },
            },
            { type: 'tool_use', id: 'tool-bad', name: 123, input: null },
          ],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      })),
    );

    const provider = createAnthropicAssistantProvider('sk-ant-test');
    const result = await provider.streamTurn({
      model: 'claude-3-5-haiku-20241022',
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'tool',
          content: '{"ignored":true}',
          toolCallId: 'tool-0',
          toolName: 'workspace_list_tasks',
        },
        { role: 'assistant', content: 'prior' },
      ],
      tools: [
        {
          name: 'workspace_list_tasks',
          description: 'list',
          inputSchema: { type: 'object' },
        },
      ],
      maxOutputTokens: 100,
      onEvent: (event) => events.push(event.type),
    });

    expect(result.text).toBe('Part one. Part two.');
    expect(result.toolCalls).toEqual([
      { id: 'tool-1', name: 'workspace_list_tasks', arguments: { projectId: 'p1' } },
      { id: 'tool-bad', name: '', arguments: {} },
    ]);
    expect(events).toEqual(['text_delta', 'tool_calls', 'usage']);
  });

  it('throws on provider errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
      })),
    );

    const provider = createAnthropicAssistantProvider('sk-ant-test');
    await expect(
      provider.streamTurn({
        model: 'claude-3-5-haiku-20241022',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/Anthropic request failed/);
  });
});

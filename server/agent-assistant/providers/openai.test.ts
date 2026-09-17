import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiAssistantProvider } from './openai.ts';

describe('OpenAI assistant provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a chat completion into text, tool calls, and usage events', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Done.',
                tool_calls: [
                  {
                    id: 'call-1',
                    function: { name: 'workspace_update_task', arguments: '{"taskId":"t1"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      })),
    );

    const provider = createOpenAiAssistantProvider('sk-test');
    const result = await provider.streamTurn({
      model: 'gpt-4o-mini',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'workspace_update_task',
          description: 'update',
          inputSchema: { type: 'object' },
        },
      ],
      maxOutputTokens: 100,
      onEvent: (event) => events.push(event.type),
    });

    expect(result.text).toBe('Done.');
    expect(result.toolCalls[0]?.name).toBe('workspace_update_task');
    expect(result.usage.totalTokens).toBe(15);
    expect(events).toEqual(['text_delta', 'tool_calls', 'usage']);
  });

  it('maps tool transcript messages and tolerates malformed tool call payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { id: 'call-bad', function: { name: 'workspace_update_task', arguments: '{' } },
                  { id: 'call-empty', function: { name: 'workspace_list_tasks', arguments: '' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      })),
    );

    const provider = createOpenAiAssistantProvider('sk-test');
    const result = await provider.streamTurn({
      model: 'gpt-4o-mini',
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'tool',
          content: '{"ok":true}',
          toolCallId: 'call-1',
          toolName: 'workspace_list_tasks',
        },
      ],
      tools: [],
      maxOutputTokens: 100,
    });

    expect(result.toolCalls).toEqual([
      { id: 'call-bad', name: 'workspace_update_task', arguments: {} },
      { id: 'call-empty', name: 'workspace_list_tasks', arguments: {} },
    ]);
  });

  it('surfaces provider failures without leaking the full response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => 'secret-details-should-not-appear-fully'.repeat(10),
      })),
    );

    const provider = createOpenAiAssistantProvider('sk-test');
    await expect(
      provider.streamTurn({
        model: 'gpt-4o-mini',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/OpenAI request failed \(401\)/);
  });
});

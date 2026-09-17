import type {
  AssistantProvider,
  AssistantToolCall,
  AssistantTurnRequest,
  AssistantTurnResult,
} from './types.ts';

function toAnthropicMessages(request: AssistantTurnRequest) {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'tool') continue;
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function parseAnthropicToolCalls(content: unknown): AssistantToolCall[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const record = block as Record<string, unknown>;
    if (record.type !== 'tool_use' || typeof record.id !== 'string') return [];
    const name = typeof record.name === 'string' ? record.name : '';
    const input =
      record.input && typeof record.input === 'object'
        ? (record.input as Record<string, unknown>)
        : {};
    return [{ id: record.id, name, arguments: input }];
  });
}

export function createAnthropicAssistantProvider(apiKey: string): AssistantProvider {
  return {
    async streamTurn(request: AssistantTurnRequest): Promise<AssistantTurnResult> {
      const body = {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.systemPrompt,
        messages: toAnthropicMessages(request),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      };
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Anthropic request failed (${response.status}): ${detail.slice(0, 200)}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const content = payload.content;
      let text = '';
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
            const piece = (block as Record<string, unknown>).text;
            if (typeof piece === 'string') text += piece;
          }
        }
      }
      const toolCalls = parseAnthropicToolCalls(content);
      if (text) request.onEvent?.({ type: 'text_delta', delta: text });
      if (toolCalls.length) request.onEvent?.({ type: 'tool_calls', calls: toolCalls });
      const usageRaw = payload.usage as Record<string, number> | undefined;
      const usage = {
        inputTokens: usageRaw?.input_tokens ?? 0,
        outputTokens: usageRaw?.output_tokens ?? 0,
        totalTokens: (usageRaw?.input_tokens ?? 0) + (usageRaw?.output_tokens ?? 0),
      };
      request.onEvent?.({ type: 'usage', usage });
      return { text, toolCalls, usage };
    },
  };
}

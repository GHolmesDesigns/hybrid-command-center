import type {
  AssistantProvider,
  AssistantToolCall,
  AssistantTurnRequest,
  AssistantTurnResult,
} from './types.ts';

type OpenAiMessage = Record<string, unknown>;

function toOpenAiMessages(request: AssistantTurnRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: 'system', content: request.systemPrompt }];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function parseToolCalls(raw: unknown): AssistantToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const fn = record.function as Record<string, unknown> | undefined;
    if (typeof record.id !== 'string' || !fn || typeof fn.name !== 'string') return [];
    let args: Record<string, unknown>;
    try {
      args =
        typeof fn.arguments === 'string' && fn.arguments.trim()
          ? (JSON.parse(fn.arguments) as Record<string, unknown>)
          : {};
    } catch {
      args = {};
    }
    return [{ id: record.id, name: fn.name, arguments: args }];
  });
}

export function createOpenAiAssistantProvider(apiKey: string): AssistantProvider {
  return {
    async streamTurn(request: AssistantTurnRequest): Promise<AssistantTurnResult> {
      const body = {
        model: request.model,
        messages: toOpenAiMessages(request),
        max_tokens: request.maxOutputTokens,
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        stream: false,
      };
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 200)}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const choice = (payload.choices as unknown[])?.[0] as Record<string, unknown> | undefined;
      const message = choice?.message as Record<string, unknown> | undefined;
      const text = typeof message?.content === 'string' ? message.content : '';
      const toolCalls = parseToolCalls(message?.tool_calls);
      if (text) request.onEvent?.({ type: 'text_delta', delta: text });
      if (toolCalls.length) request.onEvent?.({ type: 'tool_calls', calls: toolCalls });
      const usageRaw = payload.usage as Record<string, number> | undefined;
      const usage = {
        inputTokens: usageRaw?.prompt_tokens ?? 0,
        outputTokens: usageRaw?.completion_tokens ?? 0,
        totalTokens: usageRaw?.total_tokens ?? 0,
      };
      request.onEvent?.({ type: 'usage', usage });
      return { text, toolCalls, usage };
    },
  };
}

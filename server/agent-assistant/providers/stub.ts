import type {
  AssistantProvider,
  AssistantTurnRequest,
  AssistantTurnResult,
  AssistantToolCall,
} from './types.ts';

export type StubAssistantOptions = {
  proposeTool?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  delayMs?: number;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      },
      { once: true },
    );
  });

export function createStubAssistantProvider(options: StubAssistantOptions = {}): AssistantProvider {
  return {
    async streamTurn(request: AssistantTurnRequest): Promise<AssistantTurnResult> {
      const chunks = ['Hello', ' from', ' Command', ' AI.'];
      let text = '';
      for (const chunk of chunks) {
        await sleep(options.delayMs ?? 0, request.signal);
        text += chunk;
        request.onEvent?.({ type: 'text_delta', delta: chunk });
      }
      const toolCalls: AssistantToolCall[] = [];
      if (options.proposeTool !== false) {
        const call: AssistantToolCall = {
          id: 'stub-tool-1',
          name: options.toolName ?? 'workspace_add_checklist_item',
          arguments: options.toolArgs ?? {
            taskId: 'task-stub',
            text: 'Review mockups',
          },
        };
        toolCalls.push(call);
        request.onEvent?.({ type: 'tool_calls', calls: toolCalls });
      }
      const usage = { inputTokens: 42, outputTokens: 12, totalTokens: 54 };
      request.onEvent?.({ type: 'usage', usage });
      return { text, toolCalls, usage };
    },
  };
}

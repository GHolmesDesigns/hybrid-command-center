export type AssistantChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type AssistantChatMessage = {
  role: AssistantChatRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
};

export type AssistantToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AssistantToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AssistantTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AssistantStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_calls'; calls: AssistantToolCall[] }
  | { type: 'usage'; usage: AssistantTokenUsage };

export type AssistantTurnRequest = {
  model: string;
  systemPrompt: string;
  messages: AssistantChatMessage[];
  tools: AssistantToolDefinition[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  onEvent?: (event: AssistantStreamEvent) => void;
};

export type AssistantTurnResult = {
  text: string;
  toolCalls: AssistantToolCall[];
  usage: AssistantTokenUsage;
};

export interface AssistantProvider {
  streamTurn(request: AssistantTurnRequest): Promise<AssistantTurnResult>;
}

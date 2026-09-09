/**
 * MCP workflow prompts (C126).
 *
 * Prompt text is assembled only after every referenced tool has been resolved from the canonical
 * registry. If a tool is removed, its dependent prompt is omitted instead of advertising a stale
 * workflow. Tool names and completion evidence fields are read from the resolved entries.
 */
import type { McpToolRegistryEntry } from './registry.ts';
import { MCP_TOOL_REGISTRY } from './registry.ts';

export type McpPromptArgument = {
  name: string;
  description: string;
  required?: boolean;
};

export type McpPromptDefinition = {
  name: string;
  description: string;
  arguments?: readonly McpPromptArgument[];
  messages: (
    tools: ReadonlyMap<string, McpToolRegistryEntry>,
    args: Record<string, string>,
  ) => string;
};

type PromptBlueprint = McpPromptDefinition & { requiredTools: readonly string[] };

const BOUNDARY =
  'Boundary: MCP never publishes to a provider and never writes to Drive. Stop and obtain explicit operator approval outside MCP for either action.';

const toolName = (tools: ReadonlyMap<string, McpToolRegistryEntry>, name: string): string =>
  tools.get(name)!.name;

const supplied = (args: Record<string, string>, name: string): string | null => {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const completionSchema = (
  tools: ReadonlyMap<string, McpToolRegistryEntry>,
): Record<string, unknown> =>
  tools.get('coordination_complete_handoff')!.inputSchema as Record<string, unknown>;

const completionEvidenceText = (tools: ReadonlyMap<string, McpToolRegistryEntry>): string => {
  const schema = completionSchema(tools);
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const evidenceFields = Object.keys(properties).filter(
    (field) => field !== 'handoffId' && field !== 'clientRequestId',
  );
  const outcomes = Array.isArray(properties.outcome?.enum)
    ? (properties.outcome.enum as string[]).join(', ')
    : 'the outcome values exposed by the tool schema';
  return `Evidence fields: ${evidenceFields
    .map((field) => `${field}${required.has(field) ? ' (required)' : ' (optional)'}`)
    .join(', ')}. Classify outcome as one of: ${outcomes}.`;
};

const BLUEPRINTS: readonly PromptBlueprint[] = [
  {
    name: 'start_claimed_work',
    description: 'Claim a handoff, read its bounded subject context, and only then begin work.',
    arguments: [
      { name: 'handoffId', description: 'The handoff ID to claim and inspect.', required: true },
    ],
    requiredTools: [
      'coordination_claim_handoff',
      'coordination_get_handoff',
      'workspace_get_subject_context',
    ],
    messages: (tools, args) => {
      const handoffId = supplied(args, 'handoffId') ?? '<handoffId>';
      return [
        `Work handoff: ${handoffId}.`,
        `1. Call ${toolName(tools, 'coordination_claim_handoff')} with this handoff ID before doing any work. Coordination writes require the session agent_label. If another agent owns the claim or the claim is refused, stop.`,
        `2. Call ${toolName(tools, 'coordination_get_handoff')} and read the subject and current notes.`,
        `3. When the subject has a type and ID, call ${toolName(tools, 'workspace_get_subject_context')} before starting. Keep reads bounded to the subject and its blockers.`,
        '4. Start only after the claim and context reads succeed. Do not treat a claim as proof that the work is complete.',
        BOUNDARY,
      ].join('\n');
    },
  },
  {
    name: 'review_project_status',
    description: 'Review dashboard and task status with bounded, read-only MCP calls.',
    arguments: [
      { name: 'projectId', description: 'Optional project ID used to narrow the task read.' },
    ],
    requiredTools: [
      'workspace_dashboard_summary',
      'workspace_list_tasks',
      'agent_health_dashboard',
    ],
    messages: (tools, args) => {
      const projectId = supplied(args, 'projectId');
      return [
        `1. Call ${toolName(tools, 'workspace_dashboard_summary')} for the bounded workspace overview and ${toolName(tools, 'agent_health_dashboard')} for application health signals.`,
        `2. Call ${toolName(tools, 'workspace_list_tasks')}${projectId ? ` with projectId ${projectId}` : ' only when task detail is needed'}. Use the smallest useful limit and paginate deliberately; do not turn a status review into an unbounded export.`,
        '3. Separate observed rows from inference, identify blockers and stale facts, and report the bounds used.',
        'This workflow is read-only. An agent_label is required if a later, separately authorized coordination write is attempted.',
        BOUNDARY,
      ].join('\n');
    },
  },
  {
    name: 'prepare_handoff',
    description: 'Prepare a scoped handoff with a useful subject and actionable message.',
    arguments: [
      { name: 'subjectType', description: 'The handoff subject type.' },
      { name: 'subjectId', description: 'The stable subject ID when the subject is not freeform.' },
    ],
    requiredTools: ['workspace_get_subject_context', 'coordination_post_handoff'],
    messages: (tools, args) => {
      const subjectType = supplied(args, 'subjectType') ?? '<subjectType>';
      const subjectId = supplied(args, 'subjectId') ?? '<subjectId>';
      return [
        `Proposed subject: ${subjectType} / ${subjectId}.`,
        `1. For a bound subject, call ${toolName(tools, 'workspace_get_subject_context')} and confirm the stable type and ID. Do not bind a handoff to a display name.`,
        '2. Write a bounded message containing the requested outcome, current state, known blockers, relevant references, and the next concrete action. Do not include credentials or raw provider responses.',
        `3. Call ${toolName(tools, 'coordination_post_handoff')} only when the recipient and subject are correct. Coordination writes require agent_label; use clientRequestId when retrying an ambiguous request.`,
        'Posting a handoff does not claim it and does not prove its underlying work succeeded.',
        BOUNDARY,
      ].join('\n');
    },
  },
  {
    name: 'verify_before_complete',
    description: 'Verify work and record C125 structured evidence before completing a handoff.',
    arguments: [
      {
        name: 'handoffId',
        description: 'The claimed handoff to verify and complete.',
        required: true,
      },
    ],
    requiredTools: ['coordination_get_handoff', 'coordination_complete_handoff'],
    messages: (tools, args) => {
      const handoffId = supplied(args, 'handoffId') ?? '<handoffId>';
      return [
        `Verify claimed handoff: ${handoffId}.`,
        `1. Call ${toolName(tools, 'coordination_get_handoff')} and confirm this session's agent_label owns the CLAIMED handoff.`,
        '2. Re-read the requested outcome, inspect the actual changed state, and run validation proportional to the risk. Distinguish local checks, remote CI, external references, and unverified production behavior.',
        `3. Prepare ${toolName(tools, 'coordination_complete_handoff')} from the registry schema. ${completionEvidenceText(tools)}`,
        'Use resultSummary for the outcome, changedPaths for material paths, references for commits/PRs/issues, validations for command plus observed outcome, and remainingRisks for anything unresolved. Do not hide partial work in a success summary.',
        '4. Complete only after evidence is assembled. Coordination writes require agent_label; clientRequestId makes an ambiguous retry idempotent. Completion records evidence but does not mutate the subject.',
        BOUNDARY,
      ].join('\n');
    },
  },
  {
    name: 'triage_signal_queue',
    description: 'Triage Signal queue health and bounded post context without changing the queue.',
    arguments: [
      { name: 'from', description: 'Optional inclusive YYYY-MM-DD start.' },
      { name: 'to', description: 'Optional inclusive YYYY-MM-DD end.' },
    ],
    requiredTools: ['signal_queue_health', 'signal_queue_snapshot', 'signal_list_posts'],
    messages: (tools, args) => {
      const from = supplied(args, 'from');
      const to = supplied(args, 'to');
      const range =
        from || to
          ? ` Use the requested bounded range ${from ?? '<from>'} through ${to ?? '<to>'}.`
          : '';
      return [
        `1. Call ${toolName(tools, 'signal_queue_health')} first and keep each derived alert distinct from an acknowledgement or post state.`,
        `2. Call ${toolName(tools, 'signal_queue_snapshot')} for the unscheduled queue and near-term posts.${range}`,
        `3. Call ${toolName(tools, 'signal_list_posts')} only to inspect the bounded date range needed to explain an alert.`,
        '4. Report facts, missing context, and recommended operator decisions. These MCP tools may read Signal data but may not edit posts, acknowledge alerts, schedule, submit, update, cancel, or reconcile provider content.',
        'An agent_label is required for any later, separately authorized coordination write.',
        BOUNDARY,
      ].join('\n');
    },
  },
];

export function createMcpPromptRegistry(
  toolRegistry: readonly McpToolRegistryEntry[] = MCP_TOOL_REGISTRY,
): readonly McpPromptDefinition[] {
  const tools = new Map(toolRegistry.map((tool) => [tool.name, tool]));
  return BLUEPRINTS.filter((prompt) => prompt.requiredTools.every((name) => tools.has(name))).map(
    (prompt) => ({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
      messages: prompt.messages,
    }),
  );
}

export function mcpPromptsListPayload(
  prompts: readonly McpPromptDefinition[] = createMcpPromptRegistry(),
): Array<{ name: string; description: string; arguments?: readonly McpPromptArgument[] }> {
  return prompts.map(({ name, description, arguments: promptArguments }) => ({
    name,
    description,
    ...(promptArguments ? { arguments: promptArguments } : {}),
  }));
}

export function getMcpPrompt(
  name: string,
  rawArguments: unknown,
  toolRegistry: readonly McpToolRegistryEntry[] = MCP_TOOL_REGISTRY,
): {
  description: string;
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
} | null {
  const prompts = createMcpPromptRegistry(toolRegistry);
  const prompt = prompts.find((candidate) => candidate.name === name);
  if (!prompt) return null;
  const record =
    rawArguments && typeof rawArguments === 'object'
      ? (rawArguments as Record<string, unknown>)
      : {};
  const args = Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  for (const argument of prompt.arguments ?? []) {
    if (argument.required && !supplied(args, argument.name)) {
      throw new Error(`prompts/get requires argument ${argument.name}.`);
    }
  }
  const tools = new Map(toolRegistry.map((tool) => [tool.name, tool]));
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text: prompt.messages(tools, args) } }],
  };
}

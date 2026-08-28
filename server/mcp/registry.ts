/**
 * MCP tool registry (C120).
 *
 * `tools/list`, the capability descriptor, and coordination dispatch all read from here so a
 * hand-maintained tool list cannot drift from what the server actually exposes.
 */
import {
  AGENT_HANDOFF_STATES,
  AGENT_HANDOFF_SUBJECT_TYPES,
} from '../../shared/agent-coordination.ts';
import {
  COORDINATION_READ_TOOLS,
  COORDINATION_WRITE_TOOLS,
  type CoordinationTool,
} from '../../shared/mcp-agent-events.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import {
  computeMcpCapabilityVersion,
  WORKSPACE_CONTEXT_SECTIONS,
  type McpToolClass,
  type WorkspaceContextFilters,
} from '../../shared/mcp-workspace-context.ts';

export type McpToolRegistryEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  class: McpToolClass;
  requiredScope: McpAgentScope | null;
  owner: string;
  /** When set, `tools/call` routes to the named handler module. */
  handler: 'coordination' | 'system_capabilities';
};

const coordinationScope = (name: CoordinationTool): McpAgentScope =>
  (COORDINATION_WRITE_TOOLS as readonly string[]).includes(name)
    ? 'coordination:write'
    : 'coordination:read';

const coordinationTools: McpToolRegistryEntry[] = [
  {
    name: 'coordination_list_handoffs',
    description: 'List agent handoffs, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: [...AGENT_HANDOFF_STATES] },
      },
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: coordinationScope('coordination_list_handoffs'),
    owner: 'server/agent-coordination/service.ts',
    handler: 'coordination',
  },
  {
    name: 'coordination_get_handoff',
    description: 'Get one handoff and its notes.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
      },
      required: ['handoffId'],
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: coordinationScope('coordination_get_handoff'),
    owner: 'server/agent-coordination/service.ts',
    handler: 'coordination',
  },
  {
    name: 'coordination_post_handoff',
    description:
      'Create an OPEN handoff. from_agent_label is the MCP session agent_label; optional client_request_id is idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        fromAgentLabel: { type: 'string' },
        toAgentLabel: { type: ['string', 'null'] },
        subjectType: { type: 'string', enum: [...AGENT_HANDOFF_SUBJECT_TYPES] },
        subjectId: { type: ['string', 'null'] },
        message: { type: 'string' },
        clientRequestId: { type: 'string' },
      },
      required: ['subjectType', 'message'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: coordinationScope('coordination_post_handoff'),
    owner: 'server/agent-coordination/service.ts',
    handler: 'coordination',
  },
  {
    name: 'coordination_claim_handoff',
    description: 'Claim an OPEN handoff (directed label or open-pool first claim).',
    inputSchema: {
      type: 'object',
      properties: { handoffId: { type: 'string' } },
      required: ['handoffId'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: coordinationScope('coordination_claim_handoff'),
    owner: 'server/agent-coordination/service.ts',
    handler: 'coordination',
  },
  {
    name: 'coordination_complete_handoff',
    description:
      'Complete a CLAIMED handoff as the claimer. Never publishes or contacts Drive. Optional client_request_id is idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
        clientRequestId: { type: 'string' },
      },
      required: ['handoffId'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: coordinationScope('coordination_complete_handoff'),
    owner: 'server/agent-coordination/service.ts',
    handler: 'coordination',
  },
  {
    name: 'coordination_cancel_handoff',
    description:
      'Cancel an OPEN or CLAIMED handoff as the poster or claimer. Optional client_request_id is idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
        reason: { type: 'string' },
        clientRequestId: { type: 'string' },
      },
      required: ['handoffId', 'reason'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: coordinationScope('coordination_cancel_handoff'),
    owner: 'server/agent-coordination/service.ts',
    handler: 'coordination',
  },
  {
    name: 'coordination_add_note',
    description:
      'Append a note to a non-cancelled handoff. Optional client_request_id is idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
        body: { type: 'string' },
        clientRequestId: { type: 'string' },
      },
      required: ['handoffId', 'body'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: coordinationScope('coordination_add_note'),
    owner: 'server/agent-coordination/service.ts',
    handler: 'coordination',
  },
];

const systemCapabilitiesTool: McpToolRegistryEntry = {
  name: 'system_capabilities',
  description:
    'Return the same bounded workspace capability descriptor as hcc://workspace/context. Use when resource support is weak.',
  inputSchema: {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        items: { type: 'string', enum: [...WORKSPACE_CONTEXT_SECTIONS] },
      },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['clients', 'projects'] },
      },
    },
    additionalProperties: false,
  },
  class: 'R',
  requiredScope: null,
  owner: 'server/mcp/workspace-context.ts',
  handler: 'system_capabilities',
};

export const MCP_TOOL_REGISTRY: readonly McpToolRegistryEntry[] = [
  ...coordinationTools,
  systemCapabilitiesTool,
];

export const MCP_CAPABILITY_VERSION = computeMcpCapabilityVersion(
  MCP_TOOL_REGISTRY.map((tool) => tool.name),
);

export const isCoordinationTool = (name: string): name is CoordinationTool =>
  (COORDINATION_READ_TOOLS as readonly string[]).includes(name) ||
  (COORDINATION_WRITE_TOOLS as readonly string[]).includes(name);

export const isRegisteredMcpTool = (name: string): name is McpToolRegistryEntry['name'] =>
  MCP_TOOL_REGISTRY.some((tool) => tool.name === name);

export function mcpToolRegistryEntry(name: string): McpToolRegistryEntry | undefined {
  return MCP_TOOL_REGISTRY.find((tool) => tool.name === name);
}

export function mcpToolsListPayload(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return MCP_TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export function mcpToolAvailable(
  entry: McpToolRegistryEntry,
  grantedScopes: readonly McpAgentScope[],
): boolean {
  if (!entry.requiredScope) return true;
  return grantedScopes.includes(entry.requiredScope);
}

export function workspaceContextFiltersFromToolArgs(raw: unknown): WorkspaceContextFilters {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const filters: WorkspaceContextFilters = {};
  if (Array.isArray(record.sections) && record.sections.length) {
    filters.sections = record.sections as WorkspaceContextFilters['sections'];
  }
  if (Array.isArray(record.include) && record.include.length) {
    filters.include = record.include as WorkspaceContextFilters['include'];
  }
  return filters;
}

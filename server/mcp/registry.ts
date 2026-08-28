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
import { SIGNAL_LIFECYCLE_FILTERS } from '../../shared/signal.ts';
import { TASK_PRIORITIES, TASK_STATUSES } from '../../shared/types.ts';
import { MCP_TASK_LIST_MAX_LIMIT } from '../../shared/mcp-read-tools.ts';

export type McpToolRegistryEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  class: McpToolClass;
  requiredScope: McpAgentScope | null;
  owner: string;
  /** When set, `tools/call` routes to the named handler module. */
  handler: 'coordination' | 'system_capabilities' | 'system_connection_status' | 'workspace_read';
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

const workspaceReadTools: McpToolRegistryEntry[] = [
  {
    name: 'workspace_dashboard_summary',
    description: 'Dashboard counts and capped task buckets for active clients and projects.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/domain/dashboard.ts',
    handler: 'workspace_read',
  },
  {
    name: 'workspace_list_tasks',
    description: 'List active-scope tasks with optional filters and pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        clientId: { type: 'string' },
        status: { type: 'string', enum: [...TASK_STATUSES] },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        limit: { type: 'number', minimum: 1, maximum: MCP_TASK_LIST_MAX_LIMIT },
        offset: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/repositories.ts',
    handler: 'workspace_read',
  },
  {
    name: 'signal_list_posts',
    description: 'List dated Signal posts in an inclusive YYYY-MM-DD range.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        lifecycle: { type: 'string', enum: [...SIGNAL_LIFECYCLE_FILTERS] },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/signal/read.ts',
    handler: 'workspace_read',
  },
  {
    name: 'signal_queue_snapshot',
    description: 'Unscheduled queue plus upcoming dated posts (default next 30 days).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD start for upcoming posts' },
        to: { type: 'string', description: 'YYYY-MM-DD end for upcoming posts' },
        lifecycle: { type: 'string', enum: [...SIGNAL_LIFECYCLE_FILTERS] },
      },
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/signal/read.ts',
    handler: 'workspace_read',
  },
  {
    name: 'signal_queue_health',
    description: 'Derived queue-health alerts from local rows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/signal/queue-health.ts',
    handler: 'workspace_read',
  },
  {
    name: 'signal_publish_preview',
    description:
      'Build a publish preview from stored post data. Preflight only — no provider or Drive network.',
    inputSchema: {
      type: 'object',
      properties: {
        postId: { type: 'string' },
        driveOverride: { type: 'boolean' },
      },
      required: ['postId'],
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/publish/service.ts',
    handler: 'workspace_read',
  },
  {
    name: 'workspace_get_subject_context',
    description:
      'Return one bounded context package for a handoff subject — entity, parents, blocking dependencies, related handoffs, and recent activity.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectType: { type: 'string', enum: [...AGENT_HANDOFF_SUBJECT_TYPES] },
        subjectId: { type: 'string' },
      },
      required: ['subjectType', 'subjectId'],
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/mcp/workspace-subject-context.ts',
    handler: 'workspace_read',
  },
  {
    name: 'workspace_search',
    description:
      'Search clients, projects, tasks, and Signal posts by name or caption with hard result caps.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/mcp/workspace-subject-context.ts',
    handler: 'workspace_read',
  },
];

const systemConnectionStatusTool: McpToolRegistryEntry = {
  name: 'system_connection_status',
  description:
    'Read-only connection diagnostic: auth context, tools/list, resources/list, one bounded resource read, server version, capability version, and server clock. Never creates a handoff.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  class: 'R',
  requiredScope: null,
  owner: 'server/mcp/connection-status.ts',
  handler: 'system_connection_status',
};

export const MCP_TOOL_REGISTRY: readonly McpToolRegistryEntry[] = [
  ...coordinationTools,
  ...workspaceReadTools,
  systemCapabilitiesTool,
  systemConnectionStatusTool,
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

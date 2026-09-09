/**
 * MCP tool registry (C120).
 *
 * `tools/list`, the capability descriptor, and coordination dispatch all read from here so a
 * hand-maintained tool list cannot drift from what the server actually exposes.
 */
import {
  AGENT_HANDOFF_LIST_MAX_LIMIT,
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
  handler:
    | 'coordination'
    | 'system_capabilities'
    | 'system_connection_status'
    | 'workspace_read'
    | 'workspace_write'
    | 'integration_read'
    | 'integration_write'
    | 'agent_tools';
};

const coordinationScope = (name: CoordinationTool): McpAgentScope =>
  (COORDINATION_WRITE_TOOLS as readonly string[]).includes(name)
    ? 'coordination:write'
    : 'coordination:read';

const driveWriteRequestTool: McpToolRegistryEntry = {
  name: 'drive_request_write',
  description:
    'Request a Drive folder creation or bounded file upload for human approval. Never writes Drive directly.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['create-folder', 'upload-file'] },
      projectId: { type: 'string' },
      parentId: { type: 'string' },
      folderId: { type: 'string' },
      name: { type: 'string' },
      mimeType: { type: 'string' },
      contentBase64: { type: 'string' },
      clientRequestId: { type: 'string' },
    },
    required: ['kind', 'projectId', 'name', 'clientRequestId'],
    additionalProperties: false,
  },
  class: 'I',
  requiredScope: 'drive:write-request',
  owner: 'server/drive/agent-write.ts',
  handler: 'integration_write',
};

const coordinationTools: McpToolRegistryEntry[] = [
  {
    name: 'coordination_list_handoffs',
    description: 'List a bounded page of agent handoffs, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: [...AGENT_HANDOFF_STATES] },
        limit: { type: 'integer', minimum: 1, maximum: AGENT_HANDOFF_LIST_MAX_LIMIT },
        offset: { type: 'integer', minimum: 0 },
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
      'Complete a CLAIMED handoff as the claimer with a classified outcome and evidence. Never publishes or contacts Drive. Optional client_request_id is idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
        clientRequestId: { type: 'string' },
        resultSummary: { type: 'string', maxLength: 2000 },
        outcome: {
          type: 'string',
          enum: ['SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'BLOCKED', 'SUPERSEDED'],
        },
        changedPaths: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
        references: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
        validations: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', maxLength: 500 },
              outcome: { type: 'string', maxLength: 500 },
            },
            required: ['command', 'outcome'],
            additionalProperties: false,
          },
        },
        remainingRisks: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
      },
      required: ['handoffId', 'resultSummary', 'outcome'],
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

const workSessionTools: McpToolRegistryEntry[] = [
  [
    'work_start',
    'Start a leased execution session for a claimed handoff.',
    ['handoffId', 'baseRevision'],
    ['leaseSeconds', 'branch', 'worktree', 'currentStep', 'clientRequestId'],
  ],
  [
    'work_heartbeat',
    'Renew a work-session lease.',
    ['sessionId'],
    ['leaseSeconds', 'clientRequestId'],
  ],
  [
    'work_checkpoint',
    'Record resumable progress and validation evidence.',
    ['sessionId'],
    ['currentStep', 'evidence', 'validations', 'clientRequestId'],
  ],
  [
    'work_request_input',
    'Pause a session while requesting operator input.',
    ['sessionId'],
    ['currentStep', 'evidence', 'clientRequestId'],
  ],
  [
    'work_mark_blocked',
    'Mark a session blocked with evidence.',
    ['sessionId'],
    ['currentStep', 'evidence', 'clientRequestId'],
  ],
  [
    'work_release',
    'Abandon a session with an operator-visible reason.',
    ['sessionId'],
    ['clientRequestId'],
  ],
  [
    'work_complete',
    'Complete a session and feed completion evidence to its handoff.',
    ['sessionId'],
    ['currentStep', 'evidence', 'validations', 'clientRequestId'],
  ],
  ['work_get_resume_context', 'Read bounded resume context for a work session.', ['sessionId'], []],
].map(([name, description, required, optional]) => ({
  name: name as string,
  description: description as string,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      [...(required as string[]), ...(optional as string[])].map((key) => [
        key,
        { type: 'string' },
      ]),
    ),
    required: required as string[],
    additionalProperties: false,
  },
  class: (name === 'work_get_resume_context' ? 'R' : 'L') as McpToolClass,
  requiredScope: coordinationScope(name as CoordinationTool),
  owner: 'server/agent-coordination/work-sessions.ts',
  handler: 'coordination' as const,
}));

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

const agentTool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  write = false,
): McpToolRegistryEntry => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false },
  class: write ? 'L' : 'R',
  requiredScope: write ? 'workspace:write' : 'workspace:read',
  owner: 'server/agent-summaries.ts',
  handler: 'agent_tools',
});

const agentTools: McpToolRegistryEntry[] = [
  ['agent_health_dashboard', 'Read application health signals and their freshness.', {}, 'R'],
  ['agent_get_presence', 'Read the authenticated agent session presence.', {}, 'R'],
  [
    'agent_set_presence',
    'Set the authenticated agent session presence.',
    {
      state: { type: 'string', enum: ['AVAILABLE', 'BUSY', 'AWAY', 'OFFLINE'] },
      availability: { type: 'string' },
    },
    'L',
  ],
  [
    'agent_list_presence',
    'List bounded presence signals for registered agents.',
    { agentLabel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    'R',
  ],
  [
    'agent_list_summaries',
    'List bounded summaries for registered agents.',
    { agentLabel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    'R',
  ],
  [
    'agent_list_notifications',
    'List bounded agent notifications, optionally unread only.',
    { unreadOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    'R',
  ],
  [
    'agent_create_notification',
    'Create an agent notification using the existing notification service.',
    {
      incidentKey: { type: 'string' },
      kind: { type: 'string' },
      agentLabel: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
    'L',
  ],
  [
    'agent_mark_notification_read',
    'Mark one agent notification read.',
    { id: { type: 'string' } },
    'L',
  ],
].map(([name, description, properties, access]) =>
  agentTool(
    name as string,
    description as string,
    properties as Record<string, unknown>,
    access === 'L',
  ),
);

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
        projectId: { type: 'string', description: 'Only posts assigned to this project' },
        clientId: {
          type: 'string',
          description: 'Only posts assigned to projects owned by this client',
        },
        campaign: { type: 'string', description: 'Case-insensitive campaign name' },
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
    'Read-only connection diagnostic: auth context, tools/list, resources/list, one bounded resource read, server version, capability version, store id, and server clock. Never creates a handoff.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  class: 'R',
  requiredScope: null,
  owner: 'server/mcp/connection-status.ts',
  handler: 'system_connection_status',
};

const workspaceWriteTools: McpToolRegistryEntry[] = [
  {
    name: 'workspace_create_task',
    description: 'Create a task under an active project. Local SQLite only.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        projectId: { type: 'string' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        status: { type: 'string', enum: [...TASK_STATUSES] },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        taskType: { type: ['string', 'null'] },
        dueDate: { type: ['string', 'null'] },
        startDate: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
      },
      required: ['clientRequestId', 'projectId', 'title'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_update_task',
    description: 'Update a task. Requires the current revision.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        taskId: { type: 'string' },
        revision: { type: 'number' },
        projectId: { type: 'string' },
        title: { type: 'string' },
        description: { type: ['string', 'null'] },
        status: { type: 'string', enum: [...TASK_STATUSES] },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        taskType: { type: ['string', 'null'] },
        dueDate: { type: ['string', 'null'] },
        startDate: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
        overrideBlocked: { type: 'boolean' },
      },
      required: ['clientRequestId', 'taskId', 'revision'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_add_checklist_item',
    description: 'Add a checklist item. Requires the parent task revision.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        taskId: { type: 'string' },
        revision: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['clientRequestId', 'taskId', 'revision', 'text'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_update_checklist_item',
    description: 'Update a checklist item. Requires the parent task revision.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        itemId: { type: 'string' },
        revision: { type: 'number' },
        text: { type: 'string' },
        completed: { type: 'boolean' },
        position: { type: 'number' },
      },
      required: ['clientRequestId', 'itemId', 'revision'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_remove_checklist_item',
    description: 'Remove a checklist item. Requires confirm: true and matching confirmItemId.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        itemId: { type: 'string' },
        confirmItemId: { type: 'string' },
        confirm: { type: 'boolean' },
        revision: { type: 'number' },
      },
      required: ['clientRequestId', 'itemId', 'confirmItemId', 'confirm', 'revision'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_add_dependency',
    description: 'Add a task dependency. Requires the dependent task revision.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        taskId: { type: 'string' },
        dependencyId: { type: 'string' },
        revision: { type: 'number' },
      },
      required: ['clientRequestId', 'taskId', 'dependencyId', 'revision'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_remove_dependency',
    description: 'Remove a task dependency. Requires confirm: true and matching confirmTaskId.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        taskId: { type: 'string' },
        dependencyId: { type: 'string' },
        confirmTaskId: { type: 'string' },
        confirm: { type: 'boolean' },
        revision: { type: 'number' },
      },
      required: [
        'clientRequestId',
        'taskId',
        'dependencyId',
        'confirmTaskId',
        'confirm',
        'revision',
      ],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_create_project',
    description:
      'Create a project under an active client. Local SQLite only — does not provision Drive.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        clientId: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        status: { type: 'string' },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        startDate: { type: ['string', 'null'] },
        launchDate: { type: ['string', 'null'] },
        targetDeadline: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
      },
      required: ['clientRequestId', 'clientId', 'name'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_update_project',
    description: 'Update a project. Requires the current revision.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        projectId: { type: 'string' },
        revision: { type: 'number' },
        clientId: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        status: { type: 'string' },
        priority: { type: 'string', enum: [...TASK_PRIORITIES] },
        startDate: { type: ['string', 'null'] },
        launchDate: { type: ['string', 'null'] },
        targetDeadline: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] },
      },
      required: ['clientRequestId', 'projectId', 'revision'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_delete_task',
    description: 'Hard-delete a task. Requires confirm: true and matching confirmTaskId.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        taskId: { type: 'string' },
        confirmTaskId: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['clientRequestId', 'taskId', 'confirmTaskId', 'confirm'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'workspace_delete_project',
    description:
      'Hard-delete a project and its tasks locally. Never touches Drive. Requires confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        projectId: { type: 'string' },
        confirmProjectId: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['clientRequestId', 'projectId', 'confirmProjectId', 'confirm'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'signal_create_post',
    description: 'Create a Signal draft. URL media only — Drive resolve is not available over MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        clientId: { type: ['string', 'null'], format: 'uuid' },
        projectId: { type: ['string', 'null'] },
        text: { type: 'string' },
        channels: { type: 'array', items: { type: 'string' } },
        mediaUrls: { type: 'array', items: { type: 'string' } },
        date: { type: ['string', 'null'] },
        time: { type: 'string' },
        format: { type: 'string' },
        status: { type: 'string' },
        campaigns: { type: 'array', items: { type: 'string' } },
        cta: { type: ['string', 'null'] },
      },
      required: ['clientRequestId', 'text'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'workspace_write',
  },
  {
    name: 'signal_update_post',
    description: 'Update a Signal post. Requires revision. URL media only.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        postId: { type: 'string' },
        revision: { type: 'number' },
        clientId: { type: ['string', 'null'], format: 'uuid' },
        projectId: { type: ['string', 'null'] },
        text: { type: 'string' },
        channels: { type: 'array', items: { type: 'string' } },
        mediaUrls: { type: 'array', items: { type: 'string' } },
        date: { type: ['string', 'null'] },
        time: { type: 'string' },
        format: { type: 'string' },
        status: { type: 'string' },
        campaigns: { type: 'array', items: { type: 'string' } },
        cta: { type: ['string', 'null'] },
      },
      required: ['clientRequestId', 'postId', 'revision'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'workspace_write',
  },
  {
    name: 'signal_set_slot',
    description: 'Write a Signal date/time slot after occupancy recheck. Requires revision.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        postId: { type: 'string' },
        revision: { type: 'number' },
        date: { type: 'string' },
        time: { type: 'string' },
        from: { type: 'string' },
      },
      required: ['clientRequestId', 'postId', 'revision', 'date', 'time', 'from'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'workspace_write',
  },
  {
    name: 'signal_update_variants',
    description:
      'Replace Signal content variants. Pass dryRun: true for a before/after preview without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        postId: { type: 'string' },
        revision: { type: 'number' },
        dryRun: { type: 'boolean' },
        variants: { type: 'array' },
      },
      required: ['clientRequestId', 'postId', 'revision', 'variants'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'workspace_write',
  },
  {
    name: 'signal_update_publish_targets',
    description:
      'Replace Signal publish targets against locally stored connected accounts. Supports dryRun.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        postId: { type: 'string' },
        revision: { type: 'number' },
        dryRun: { type: 'boolean' },
        targets: { type: 'array' },
      },
      required: ['clientRequestId', 'postId', 'revision', 'targets'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'workspace_write',
  },
  {
    name: 'signal_duplicate_post',
    description: 'Duplicate a Signal post into the unscheduled draft queue.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        postId: { type: 'string' },
      },
      required: ['clientRequestId', 'postId'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'workspace_write',
  },
  {
    name: 'signal_ack_alert',
    description: 'Acknowledge a queue-health alert by id and fingerprint.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        alertId: { type: 'string' },
      },
      required: ['clientRequestId', 'alertId'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/signal/queue-health.ts',
    handler: 'workspace_write',
  },
  {
    name: 'settings_update_branding',
    description: 'Replace sidebar branding settings.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        mark: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        tagline: { type: 'string' },
        background: { type: 'string' },
        foreground: { type: 'string' },
        accent: { type: 'string' },
        logoUrl: { type: 'string' },
        logoAlt: { type: 'string' },
      },
      required: ['clientRequestId', 'mark', 'title', 'subtitle', 'tagline'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
  {
    name: 'settings_update_view_defaults',
    description: 'Replace view defaults settings.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        viewDefaults: { type: 'object' },
      },
      required: ['clientRequestId', 'viewDefaults'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/workspace/writes.ts',
    handler: 'workspace_write',
  },
];

const integrationTools: McpToolRegistryEntry[] = [
  {
    name: 'workspace_merge_clients_preview',
    description: 'Preview merging one client into another without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', format: 'uuid' },
        destinationId: { type: 'string', format: 'uuid' },
        fields: { type: 'object' },
      },
      required: ['sourceId', 'destinationId'],
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/client-merge.ts',
    handler: 'integration_read',
  },
  {
    name: 'workspace_merge_clients_commit',
    description:
      'Commit a client merge when planHash still matches the workspace. Shares the coordination write budget.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        sourceId: { type: 'string', format: 'uuid' },
        destinationId: { type: 'string', format: 'uuid' },
        fields: { type: 'object' },
        planHash: { type: 'string', minLength: 64, maxLength: 64 },
      },
      required: ['clientRequestId', 'sourceId', 'destinationId', 'planHash'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/client-merge.ts',
    handler: 'integration_write',
  },
  {
    name: 'import_playbook_preview',
    description: 'Preview a campaign playbook import without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        contentBase64: { type: 'string' },
        text: { type: 'string' },
      },
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/import.ts',
    handler: 'integration_read',
  },
  {
    name: 'import_playbook_commit',
    description:
      'Commit a campaign playbook import when the preview fingerprint still matches. Shares the coordination write budget.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        filename: { type: 'string' },
        contentBase64: { type: 'string' },
        text: { type: 'string' },
        fingerprint: { type: 'string' },
      },
      required: ['clientRequestId'],
      additionalProperties: false,
    },
    class: 'L',
    requiredScope: 'workspace:write',
    owner: 'server/import.ts',
    handler: 'integration_write',
  },
  {
    name: 'import_signal_preview',
    description: 'Preview a Signal schedule import without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        contentBase64: { type: 'string' },
        text: { type: 'string' },
      },
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/signal/import.ts',
    handler: 'integration_read',
  },
  {
    name: 'import_signal_commit',
    description:
      'Commit a Signal schedule import when the preview fingerprint still matches. Uses the integration write budget.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        filename: { type: 'string' },
        contentBase64: { type: 'string' },
        text: { type: 'string' },
        fingerprint: { type: 'string' },
      },
      required: ['clientRequestId'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/signal/import.ts',
    handler: 'integration_write',
  },
  {
    name: 'signal_resolve_drive_media',
    description:
      'Resolve one Drive link to Signal media metadata and version fingerprint. Never reads bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        link: { type: 'string' },
      },
      required: ['clientRequestId', 'link'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/drive/media.ts',
    handler: 'integration_write',
  },
  {
    name: 'signal_resolve_drive_media_batch',
    description:
      'Resolve every item in a project-owned Drive folder to Signal media metadata. Returns per-item outcomes, never reads bytes, and refuses folders over the batch limit.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        projectId: { type: 'string', format: 'uuid' },
        folderId: { type: 'string' },
      },
      required: ['clientRequestId', 'projectId'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/drive/media-batch.ts',
    handler: 'integration_write',
  },
  {
    name: 'signal_recheck_post_media',
    description:
      'Recheck one stored Drive media reference on a Signal post against current Drive metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        postId: { type: 'string', format: 'uuid' },
        driveFileId: { type: 'string' },
      },
      required: ['clientRequestId', 'postId', 'driveFileId'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'integration_write',
  },
  {
    name: 'signal_recheck_variant_media',
    description:
      'Recheck one stored Drive cover image or thumbnail on a Signal variant against current Drive metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        postId: { type: 'string', format: 'uuid' },
        platform: { type: 'string' },
        accountId: { type: ['number', 'null'] },
        role: { type: 'string', enum: ['COVER_IMAGE', 'THUMBNAIL'] },
      },
      required: ['clientRequestId', 'postId', 'platform', 'accountId', 'role'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/signal/service.ts',
    handler: 'integration_write',
  },
  {
    name: 'drive_sync',
    description:
      'Provision Drive folders for active clients and projects. Records drive.sync on the integration activity log.',
    inputSchema: {
      type: 'object',
      properties: { clientRequestId: { type: 'string' } },
      required: ['clientRequestId'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/drive/service.ts',
    handler: 'integration_write',
  },
  {
    name: 'signal_refresh_provider_inventory',
    description:
      'Refresh the stored provider inventory snapshot. A failed refresh leaves the prior generation in place.',
    inputSchema: {
      type: 'object',
      properties: { clientRequestId: { type: 'string' } },
      required: ['clientRequestId'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/publish/inventory.ts',
    handler: 'integration_write',
  },
  {
    name: 'signal_refresh_analytics_window',
    description: 'Refresh one analytics platform/timeframe window from the provider.',
    inputSchema: {
      type: 'object',
      properties: {
        clientRequestId: { type: 'string' },
        platform: { type: 'string' },
        timeframe: { type: 'string' },
      },
      required: ['clientRequestId', 'platform', 'timeframe'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/publish/analytics-window.ts',
    handler: 'integration_write',
  },
  {
    name: 'signal_refresh_buffer_accounts',
    description: 'Refresh the stored Buffer accounts snapshot.',
    inputSchema: {
      type: 'object',
      properties: { clientRequestId: { type: 'string' } },
      required: ['clientRequestId'],
      additionalProperties: false,
    },
    class: 'I',
    requiredScope: 'workspace:write',
    owner: 'server/publish/buffer-accounts.ts',
    handler: 'integration_write',
  },
  {
    name: 'files_browse_project',
    description:
      'List files in a project Drive folder or one of its recorded drive_steps. Refuses any other folder id.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', format: 'uuid' },
        folderId: { type: 'string' },
        pageToken: { type: 'string' },
        pageSize: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/drive/browse.ts',
    handler: 'integration_read',
  },
  {
    name: 'integration_list_activity',
    description: 'List recent integration activity events, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['campaign-playbook', 'signal-import', 'signal-campaign', 'google-drive'],
        },
        correlationId: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    class: 'R',
    requiredScope: 'workspace:read',
    owner: 'server/integration-log.ts',
    handler: 'integration_read',
  },
];

export const MCP_TOOL_REGISTRY: readonly McpToolRegistryEntry[] = [
  driveWriteRequestTool,
  ...coordinationTools,
  ...workSessionTools,
  ...workspaceReadTools,
  ...workspaceWriteTools,
  ...integrationTools,
  ...agentTools,
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

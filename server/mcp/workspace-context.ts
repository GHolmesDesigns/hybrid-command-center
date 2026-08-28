/**
 * Workspace capability descriptor composition (C120).
 *
 * Gathers counts and headlines from existing modules — no new domain rules. Applies a hard byte
 * ceiling with declared truncation and optional section filters.
 */
import type { Db } from '../db.ts';
import { listHandoffs } from '../agent-coordination/service.ts';
import { listActiveTasks, listClients, listProjects } from '../repositories.ts';
import { readQueueHealth } from '../signal/queue-health.ts';
import { APP_VERSION } from '../../shared/branding.ts';
import { isOverdue } from '../../shared/deadlines.ts';
import { MCP_AGENT_SCOPES, type McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import {
  MCP_APPROVAL_BOUNDARIES,
  WORKSPACE_CONTEXT_BYTE_CEILING,
  parseWorkspaceContextUri,
  type WorkspaceContextDescriptor,
  type WorkspaceContextFilters,
  type WorkspaceContextInclude,
  type WorkspaceContextSection,
  utf8ByteLength,
} from '../../shared/mcp-workspace-context.ts';
import { queueHealthHeadline } from '../../shared/queue-health.ts';
import type { Client, Project } from '../../shared/types.ts';
import { MCP_CAPABILITY_VERSION, MCP_TOOL_REGISTRY, mcpToolAvailable } from './registry.ts';
import { redactToolResult } from './redact.ts';

export const WORKSPACE_CONTEXT_RESOURCE_DEFINITION = {
  uri: 'hcc://workspace/context',
  name: 'Workspace context',
  description:
    'Compact capability snapshot: version, workspace counts, handoffs, queue health, tools, and approval boundaries.',
  mimeType: 'application/json',
} as const;

const sectionEnabled = (
  filters: WorkspaceContextFilters,
  section: WorkspaceContextSection,
): boolean => {
  if (!filters.sections?.length) return true;
  return filters.sections.includes(section);
};

const includeEnabled = (
  filters: WorkspaceContextFilters,
  include: WorkspaceContextInclude,
): boolean => Boolean(filters.include?.includes(include));

export function buildWorkspaceContextDescriptor(
  db: Db,
  options: {
    grantedScopes?: readonly McpAgentScope[];
    filters?: WorkspaceContextFilters;
    now?: Date;
  } = {},
): WorkspaceContextDescriptor {
  const now = options.now ?? new Date();
  const filters = options.filters ?? {};
  const grantedScopes = [...(options.grantedScopes ?? MCP_AGENT_SCOPES)];
  const descriptor: WorkspaceContextDescriptor = {
    appVersion: APP_VERSION,
    capabilityVersion: MCP_CAPABILITY_VERSION,
    generatedAt: now.toISOString(),
    grantedScopes,
  };

  if (sectionEnabled(filters, 'workspace')) {
    const tasks = listActiveTasks(db);
    const clients = (listClients(db) as Client[]).filter((client) => client.status === 'ACTIVE');
    const projects = (listProjects(db) as Project[]).filter(
      (project) => project.status === 'ACTIVE',
    );
    const overdueTasks = tasks.filter((task) => isOverdue(task, now));
    const blockedTasks = tasks.filter((task) => task.status !== 'COMPLETE' && task.blocked);
    descriptor.workspace = {
      activeClients: clients.length,
      activeProjects: projects.length,
      overdueTasks: overdueTasks.length,
      blockedTasks: blockedTasks.length,
      ...(includeEnabled(filters, 'clients')
        ? {
            clients: clients.map((client) => ({ id: client.id, name: client.name })),
          }
        : {}),
      ...(includeEnabled(filters, 'projects')
        ? {
            projects: projects.map((project) => ({
              id: project.id,
              name: project.name,
              clientName: project.clientName ?? '',
            })),
          }
        : {}),
    };
  }

  if (sectionEnabled(filters, 'handoffs')) {
    descriptor.handoffs = {
      open: listHandoffs(db, { state: 'OPEN' }).length,
      claimed: listHandoffs(db, { state: 'CLAIMED' }).length,
    };
  }

  if (sectionEnabled(filters, 'queueHealth')) {
    const summary = readQueueHealth(db, now);
    descriptor.queueHealth = {
      headline: queueHealthHeadline(summary),
      action: summary.counts.action,
      watch: summary.counts.watch,
      acknowledged: summary.counts.acknowledged,
    };
  }

  if (sectionEnabled(filters, 'tools')) {
    descriptor.tools = MCP_TOOL_REGISTRY.map((entry) => ({
      name: entry.name,
      class: entry.class,
      requiredScope: entry.requiredScope,
      available: mcpToolAvailable(entry, grantedScopes),
      owner: entry.owner,
    }));
  }

  if (sectionEnabled(filters, 'approvalBoundaries')) {
    descriptor.approvalBoundaries = MCP_APPROVAL_BOUNDARIES.map((boundary) => ({ ...boundary }));
  }

  return applyWorkspaceContextCeiling(descriptor);
}

function applyWorkspaceContextCeiling(
  descriptor: WorkspaceContextDescriptor,
): WorkspaceContextDescriptor {
  let current = descriptor;
  const trimmed: string[] = [];
  const trySerialize = (value: WorkspaceContextDescriptor) =>
    utf8ByteLength(JSON.stringify(redactToolResult(value)));

  let byteLength = trySerialize(current);
  if (byteLength <= WORKSPACE_CONTEXT_BYTE_CEILING) return current;

  if (current.workspace?.clients?.length) {
    const { clients, ...workspace } = current.workspace;
    void clients;
    current = { ...current, workspace };
    trimmed.push('workspace.clients');
    byteLength = trySerialize(current);
    if (byteLength <= WORKSPACE_CONTEXT_BYTE_CEILING) {
      return withTruncation(current, trimmed, byteLength);
    }
  }

  if (current.workspace?.projects?.length) {
    const { projects, ...workspace } = current.workspace;
    void projects;
    current = { ...current, workspace };
    trimmed.push('workspace.projects');
    byteLength = trySerialize(current);
    if (byteLength <= WORKSPACE_CONTEXT_BYTE_CEILING) {
      return withTruncation(current, trimmed, byteLength);
    }
  }

  if (current.queueHealth) {
    const { queueHealth, ...rest } = current;
    void queueHealth;
    current = rest;
    trimmed.push('queueHealth');
    byteLength = trySerialize(current);
    if (byteLength <= WORKSPACE_CONTEXT_BYTE_CEILING) {
      return withTruncation(current, trimmed, byteLength);
    }
  }

  if (current.handoffs) {
    const { handoffs, ...rest } = current;
    void handoffs;
    current = rest;
    trimmed.push('handoffs');
    byteLength = trySerialize(current);
    if (byteLength <= WORKSPACE_CONTEXT_BYTE_CEILING) {
      return withTruncation(current, trimmed, byteLength);
    }
  }

  return withTruncation(current, trimmed, byteLength);
}

function withTruncation(
  descriptor: WorkspaceContextDescriptor,
  trimmed: string[],
  byteLength: number,
): WorkspaceContextDescriptor {
  if (!trimmed.length && byteLength <= WORKSPACE_CONTEXT_BYTE_CEILING) return descriptor;
  return {
    ...descriptor,
    truncation: {
      applied: true,
      byteCeiling: WORKSPACE_CONTEXT_BYTE_CEILING,
      byteLength,
      trimmed,
    },
  };
}

export function readWorkspaceContextResource(
  db: Db,
  uri: string,
  grantedScopes?: readonly McpAgentScope[],
  now: Date = new Date(),
): {
  uri: string;
  mimeType: string;
  text: string;
} {
  const filters = parseWorkspaceContextUri(uri);
  const payload = buildWorkspaceContextDescriptor(db, { grantedScopes, filters, now });
  return {
    uri: WORKSPACE_CONTEXT_RESOURCE_DEFINITION.uri,
    mimeType: WORKSPACE_CONTEXT_RESOURCE_DEFINITION.mimeType,
    text: JSON.stringify(redactToolResult(payload)),
  };
}

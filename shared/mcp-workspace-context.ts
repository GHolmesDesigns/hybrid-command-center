/**
 * Workspace context resource vocabulary (C120).
 *
 * `hcc://workspace/context` and `system_capabilities` share one bounded descriptor. Truncation is
 * always declared in the payload rather than applied silently.
 */
import { z } from 'zod';
import type { McpAgentScope } from './mcp-agent-registry.ts';

export const WORKSPACE_CONTEXT_URI = 'hcc://workspace/context';

/** Hard ceiling for the JSON text of one descriptor read. */
export const WORKSPACE_CONTEXT_BYTE_CEILING = 48_000;

export const WORKSPACE_CONTEXT_SECTIONS = [
  'workspace',
  'handoffs',
  'queueHealth',
  'tools',
  'approvalBoundaries',
] as const;
export type WorkspaceContextSection = (typeof WORKSPACE_CONTEXT_SECTIONS)[number];

export const WORKSPACE_CONTEXT_INCLUDES = ['clients', 'projects'] as const;
export type WorkspaceContextInclude = (typeof WORKSPACE_CONTEXT_INCLUDES)[number];

export const workspaceContextSectionSchema = z.enum(WORKSPACE_CONTEXT_SECTIONS);
export const workspaceContextIncludeSchema = z.enum(WORKSPACE_CONTEXT_INCLUDES);

export const workspaceContextFiltersSchema = z
  .object({
    sections: z.array(workspaceContextSectionSchema).min(1).optional(),
    include: z.array(workspaceContextIncludeSchema).optional(),
  })
  .strict();

export type WorkspaceContextFilters = z.infer<typeof workspaceContextFiltersSchema>;

/** Operations that stay UI-only regardless of credential scope. */
export const MCP_APPROVAL_BOUNDARIES = [
  {
    id: 'provider_publish',
    summary:
      'Provider publish, apply, reconcile, cancel, and publish-now are human-confirmed UI only and never reachable over MCP.',
  },
  {
    id: 'drive_writes',
    summary:
      'Drive upload, download, move, rename, and delete are never available over MCP; Files is browse-only.',
  },
  {
    id: 'permanent_client_deletion',
    summary:
      'Permanent client deletion is never available over MCP; clients are archived, not destroyed.',
  },
] as const;

export type McpToolClass = 'R' | 'L' | 'I' | 'P';

export type WorkspaceContextToolDescriptor = {
  name: string;
  class: McpToolClass;
  requiredScope: McpAgentScope | null;
  available: boolean;
  owner: string;
};

export type WorkspaceContextTruncation = {
  applied: true;
  byteCeiling: number;
  byteLength: number;
  trimmed: string[];
};

export type WorkspaceContextDescriptor = {
  appVersion: string;
  capabilityVersion: string;
  generatedAt: string;
  grantedScopes: McpAgentScope[];
  workspace?: {
    activeClients: number;
    activeProjects: number;
    overdueTasks: number;
    blockedTasks: number;
    clients?: Array<{ id: string; name: string }>;
    projects?: Array<{ id: string; name: string; clientName: string }>;
  };
  handoffs?: { open: number; claimed: number };
  queueHealth?: { headline: string; action: number; watch: number; acknowledged: number };
  tools?: WorkspaceContextToolDescriptor[];
  approvalBoundaries?: Array<{ id: string; summary: string }>;
  truncation?: WorkspaceContextTruncation;
};

/** Stable version string that changes when the registered tool set changes. */
export function computeMcpCapabilityVersion(toolNames: readonly string[]): string {
  const material = [...toolNames].sort().join('\n');
  let hash = 0;
  for (let index = 0; index < material.length; index += 1) {
    hash = (hash * 31 + material.charCodeAt(index)) >>> 0;
  }
  return `mcp-${hash.toString(16).padStart(8, '0')}`;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function parseWorkspaceContextUri(uri: string): WorkspaceContextFilters {
  const normalized = uri.trim();
  if (!normalized.startsWith('hcc://workspace/context')) {
    throw new Error(`Unknown workspace resource: ${uri}`);
  }
  const parsed = new URL(normalized);
  if (
    parsed.protocol !== 'hcc:' ||
    parsed.hostname !== 'workspace' ||
    parsed.pathname !== '/context'
  ) {
    throw new Error(`Unknown workspace resource: ${uri}`);
  }
  const sectionsRaw = parsed.searchParams.getAll('section').length
    ? parsed.searchParams.getAll('section')
    : (parsed.searchParams.get('sections')?.split(',') ?? []);
  const includeRaw = parsed.searchParams.getAll('include').length
    ? parsed.searchParams.getAll('include')
    : (parsed.searchParams.get('include')?.split(',') ?? []);
  const sections = sectionsRaw
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const include = includeRaw
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const filters = workspaceContextFiltersSchema.parse({
    ...(sections.length ? { sections } : {}),
    ...(include.length ? { include } : {}),
  });
  return filters;
}

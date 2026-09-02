/**
 * MCP subject context and workspace search (C123).
 *
 * One bounded package for a handoff subject, and a capped name search across workspace tables.
 * Domain shapes come from existing repositories and services; this module gathers and caps them.
 */
import type { Db } from '../db.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { getTask, listClients, listProjects } from '../repositories.ts';
import { getPost } from '../signal/service.ts';
import type {
  AgentHandoff,
  AgentHandoffSubjectType,
  AgentIdentityProvenance,
} from '../../shared/agent-coordination.ts';
import type { IntegrationEntityType, IntegrationEvent } from '../../shared/integration-log.ts';
import {
  MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT,
  MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT,
  MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT,
  MCP_WORKSPACE_SEARCH_TOTAL_LIMIT,
  type McpSubjectContextArgs,
  type McpWorkspaceSearchArgs,
} from '../../shared/mcp-read-tools.ts';
import type { Client, Project, Task } from '../../shared/types.ts';
import type { SignalPost } from '../../shared/signal.ts';

export type WorkspaceSearchResult = {
  subjectType: Exclude<AgentHandoffSubjectType, 'freeform'>;
  subjectId: string;
  label: string;
  matchField: 'name' | 'title' | 'text';
};

export type SubjectContextPayload = {
  subjectType: AgentHandoffSubjectType;
  subjectId: string;
  caps: {
    relatedHandoffs: number;
    recentActivity: number;
  };
  entity: Client | Project | Task | SignalPost;
  parents: {
    project?: Project;
    client?: Client;
  };
  blockingDependencies?: { id: string; title: string }[];
  relatedHandoffs: AgentHandoff[];
  recentActivity: IntegrationEvent[];
  truncated: {
    relatedHandoffs: boolean;
    recentActivity: boolean;
  };
};

export type WorkspaceSearchPayload = {
  query: string;
  caps: {
    perType: number;
    total: number;
  };
  results: WorkspaceSearchResult[];
  truncated: boolean;
};

const INTEGRATION_ENTITY_BY_SUBJECT: Partial<
  Record<AgentHandoffSubjectType, IntegrationEntityType>
> = {
  client: 'client',
  project: 'project',
  task: 'task',
  signal_post: 'signalPost',
};

interface HandoffRow {
  id: string;
  created_at: string;
  updated_at: string;
  from_agent_label: string;
  from_agent_provenance: string;
  to_agent_label: string | null;
  subject_type: string;
  subject_id: string | null;
  message: string;
  state: string;
  claimed_by: string | null;
  claimed_by_provenance: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  completed_by_provenance: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  client_request_id: string | null;
}

const toHandoff = (row: HandoffRow): AgentHandoff => ({
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  fromAgentLabel: row.from_agent_label,
  fromAgentProvenance: row.from_agent_provenance as AgentIdentityProvenance,
  toAgentLabel: row.to_agent_label,
  subjectType: row.subject_type as AgentHandoffSubjectType,
  subjectId: row.subject_id,
  message: row.message,
  state: row.state as AgentHandoff['state'],
  claimedBy: row.claimed_by,
  claimedByProvenance: row.claimed_by_provenance as AgentIdentityProvenance | null,
  claimedAt: row.claimed_at,
  completedAt: row.completed_at,
  completedByProvenance: row.completed_by_provenance as AgentIdentityProvenance | null,
  cancelledAt: row.cancelled_at,
  cancelReason: row.cancel_reason,
  clientRequestId: row.client_request_id,
});

function getClient(db: Db, id: string): Client | undefined {
  return listClients(db).find((client) => client.id === id);
}

function getProject(db: Db, id: string): Project | undefined {
  const projects = listProjects(db) as Project[];
  return projects.find((project) => project.id === id);
}

function listRelatedHandoffs(
  db: Db,
  subjectType: AgentHandoffSubjectType,
  subjectId: string,
): { handoffs: AgentHandoff[]; truncated: boolean } {
  const rows = db
    .prepare(
      `SELECT * FROM agent_handoffs
       WHERE subject_type = ? AND subject_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(subjectType, subjectId) as unknown as HandoffRow[];
  const handoffs = rows.slice(0, MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT).map(toHandoff);
  return {
    handoffs,
    truncated: rows.length > MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT,
  };
}

function listSubjectActivity(
  db: Db,
  subjectType: AgentHandoffSubjectType,
  subjectId: string,
): { activity: IntegrationEvent[]; truncated: boolean } {
  const entityType = INTEGRATION_ENTITY_BY_SUBJECT[subjectType];
  if (!entityType) return { activity: [], truncated: false };

  const candidates = listIntegrationEvents(db, {
    limit: MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT * 4,
  });
  const matched = candidates.filter((event) =>
    event.entities.some((entity) => entity.type === entityType && entity.id === subjectId),
  );
  return {
    activity: matched.slice(0, MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT),
    truncated: matched.length > MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT,
  };
}

function parentsForTask(
  db: Db,
  task: Task,
): {
  parents: SubjectContextPayload['parents'];
  blockingDependencies: Task['blockingDependencies'];
} {
  const project = getProject(db, task.projectId);
  const client = project ? getClient(db, project.clientId) : undefined;
  return {
    parents: {
      ...(project ? { project } : {}),
      ...(client ? { client } : {}),
    },
    blockingDependencies: task.blockingDependencies,
  };
}

function parentsForProject(db: Db, project: Project): SubjectContextPayload['parents'] {
  const client = getClient(db, project.clientId);
  return client ? { client } : {};
}

export function buildSubjectContext(
  db: Db,
  args: McpSubjectContextArgs,
): SubjectContextPayload | null {
  const { subjectType, subjectId } = args;

  if (subjectType === 'freeform') return null;

  let entity: Client | Project | Task | SignalPost | undefined;
  let parents: SubjectContextPayload['parents'] = {};
  let blockingDependencies: SubjectContextPayload['blockingDependencies'];

  switch (subjectType) {
    case 'client':
      entity = getClient(db, subjectId);
      break;
    case 'project': {
      const project = getProject(db, subjectId);
      entity = project;
      if (project) parents = parentsForProject(db, project);
      break;
    }
    case 'task': {
      const task = getTask(db, subjectId);
      entity = task;
      if (task) {
        const taskContext = parentsForTask(db, task);
        parents = taskContext.parents;
        blockingDependencies = taskContext.blockingDependencies;
      }
      break;
    }
    case 'signal_post':
      entity = getPost(db, subjectId);
      break;
  }

  if (!entity) return null;

  const { handoffs, truncated: handoffsTruncated } = listRelatedHandoffs(
    db,
    subjectType,
    subjectId,
  );
  const { activity, truncated: activityTruncated } = listSubjectActivity(
    db,
    subjectType,
    subjectId,
  );

  return {
    subjectType,
    subjectId,
    caps: {
      relatedHandoffs: MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT,
      recentActivity: MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT,
    },
    entity,
    parents,
    ...(blockingDependencies?.length ? { blockingDependencies } : {}),
    relatedHandoffs: handoffs,
    recentActivity: activity,
    truncated: {
      relatedHandoffs: handoffsTruncated,
      recentActivity: activityTruncated,
    },
  };
}

const escapeLike = (query: string) => query.replace(/[%_\\]/g, (char) => `\\${char}`);

function searchByType(
  db: Db,
  pattern: string,
  search: (db: Db, pattern: string, fetchLimit: number) => WorkspaceSearchResult[],
): { results: WorkspaceSearchResult[]; truncated: boolean } {
  const fetchLimit = MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT + 1;
  const rows = search(db, pattern, fetchLimit);
  return {
    results: rows.slice(0, MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT),
    truncated: rows.length > MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT,
  };
}

function searchClients(db: Db, pattern: string, fetchLimit: number): WorkspaceSearchResult[] {
  return (
    db
      .prepare(
        `SELECT id, name FROM clients
         WHERE name LIKE ? ESCAPE '\\' AND status <> 'ARCHIVED'
         ORDER BY name COLLATE NOCASE LIMIT ?`,
      )
      .all(pattern, fetchLimit) as { id: string; name: string }[]
  ).map((row) => ({
    subjectType: 'client' as const,
    subjectId: row.id,
    label: row.name,
    matchField: 'name' as const,
  }));
}

function searchProjects(db: Db, pattern: string, fetchLimit: number): WorkspaceSearchResult[] {
  return (
    db
      .prepare(
        `SELECT p.id, p.name FROM projects p
         JOIN clients c ON c.id = p.client_id
         WHERE p.name LIKE ? ESCAPE '\\' AND p.status <> 'ARCHIVED' AND c.status <> 'ARCHIVED'
         ORDER BY p.name COLLATE NOCASE LIMIT ?`,
      )
      .all(pattern, fetchLimit) as { id: string; name: string }[]
  ).map((row) => ({
    subjectType: 'project' as const,
    subjectId: row.id,
    label: row.name,
    matchField: 'name' as const,
  }));
}

function searchTasks(db: Db, pattern: string, fetchLimit: number): WorkspaceSearchResult[] {
  return (
    db
      .prepare(
        `SELECT t.id, t.title FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN clients c ON c.id = p.client_id
         WHERE t.title LIKE ? ESCAPE '\\' AND p.status <> 'ARCHIVED' AND c.status <> 'ARCHIVED'
         ORDER BY t.title COLLATE NOCASE LIMIT ?`,
      )
      .all(pattern, fetchLimit) as { id: string; title: string }[]
  ).map((row) => ({
    subjectType: 'task' as const,
    subjectId: row.id,
    label: row.title,
    matchField: 'title' as const,
  }));
}

function searchSignalPosts(db: Db, pattern: string, fetchLimit: number): WorkspaceSearchResult[] {
  return (
    db
      .prepare(
        `SELECT id, text FROM signal_posts
         WHERE text LIKE ? ESCAPE '\\' AND lifecycle = 'ACTIVE'
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(pattern, fetchLimit) as { id: string; text: string }[]
  ).map((row) => ({
    subjectType: 'signal_post' as const,
    subjectId: row.id,
    label: row.text.trim().slice(0, 120),
    matchField: 'text' as const,
  }));
}

export function buildWorkspaceSearch(db: Db, args: McpWorkspaceSearchArgs): WorkspaceSearchPayload {
  const query = args.query.trim();
  const pattern = `%${escapeLike(query)}%`;
  const clientHits = searchByType(db, pattern, searchClients);
  const projectHits = searchByType(db, pattern, searchProjects);
  const taskHits = searchByType(db, pattern, searchTasks);
  const signalHits = searchByType(db, pattern, searchSignalPosts);
  const perTypeResults = [
    ...clientHits.results,
    ...projectHits.results,
    ...taskHits.results,
    ...signalHits.results,
  ];
  const results = perTypeResults.slice(0, MCP_WORKSPACE_SEARCH_TOTAL_LIMIT);
  const truncated =
    perTypeResults.length > MCP_WORKSPACE_SEARCH_TOTAL_LIMIT ||
    clientHits.truncated ||
    projectHits.truncated ||
    taskHits.truncated ||
    signalHits.truncated;

  return {
    query,
    caps: {
      perType: MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT,
      total: MCP_WORKSPACE_SEARCH_TOTAL_LIMIT,
    },
    results,
    truncated,
  };
}

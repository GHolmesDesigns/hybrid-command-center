import { beforeEach, describe, expect, it } from 'vitest';
import { format, subDays } from 'date-fns';
import { createDb, type Db } from '../db.ts';
import { buildWorkspaceContextDescriptor } from './workspace-context.ts';
import { MCP_CAPABILITY_VERSION, MCP_TOOL_REGISTRY, mcpToolsListPayload } from './registry.ts';
import {
  utf8ByteLength,
  WORKSPACE_CONTEXT_BYTE_CEILING,
} from '../../shared/mcp-workspace-context.ts';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const past = format(subDays(NOW, 3), 'yyyy-MM-dd');

let db: Db;

const addClient = (id: string, name: string) =>
  db
    .prepare(
      `INSERT INTO clients (id, name, slug, status, drive_status, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', 'DISCONNECTED', ?, ?)`,
    )
    .run(id, name, `slug-${id}`, NOW.toISOString(), NOW.toISOString());

const addProject = (id: string, clientId: string, name: string) =>
  db
    .prepare(
      `INSERT INTO projects (id, client_id, name, status, priority, position, drive_status,
         created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, 'ACTIVE', 'MEDIUM', 0, 'DISCONNECTED', ?, ?, ?)`,
    )
    .run(id, clientId, name, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());

const addTask = (
  id: string,
  projectId: string,
  title: string,
  extra: { status?: string; dueDate?: string | null } = {},
) =>
  db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, due_date,
         position, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'MEDIUM', ?, 0, ?, ?)`,
    )
    .run(
      id,
      projectId,
      title,
      extra.status ?? 'TODO',
      extra.dueDate ?? null,
      NOW.toISOString(),
      NOW.toISOString(),
    );

beforeEach(() => {
  db = createDb(':memory:');
  addClient('c1', 'Acme Studio');
  addProject('p1', 'c1', 'Identity System');
});

describe('buildWorkspaceContextDescriptor', () => {
  it('includes approval boundaries, tools from the registry, and credential scopes', () => {
    const descriptor = buildWorkspaceContextDescriptor(db, {
      grantedScopes: ['coordination:read'],
      now: NOW,
    });
    expect(descriptor.capabilityVersion).toBe(MCP_CAPABILITY_VERSION);
    expect(descriptor.tools?.map((tool) => tool.name)).toEqual(
      MCP_TOOL_REGISTRY.map((tool) => tool.name),
    );
    expect(descriptor.grantedScopes).toEqual(['coordination:read']);
    expect(
      descriptor.tools?.find((tool) => tool.name === 'coordination_post_handoff')?.available,
    ).toBe(false);
    expect(
      descriptor.tools?.find((tool) => tool.name === 'coordination_list_handoffs')?.available,
    ).toBe(true);
    expect(descriptor.approvalBoundaries?.length).toBeGreaterThan(0);
  });

  it('matches tools/list names from the registry', () => {
    const descriptor = buildWorkspaceContextDescriptor(db, { now: NOW });
    expect(descriptor.tools?.map((tool) => tool.name)).toEqual(
      mcpToolsListPayload().map((tool) => tool.name),
    );
  });

  it('honours section filters', () => {
    const descriptor = buildWorkspaceContextDescriptor(db, {
      filters: { sections: ['workspace'] },
      now: NOW,
    });
    expect(descriptor.workspace).toBeDefined();
    expect(descriptor.tools).toBeUndefined();
    expect(descriptor.queueHealth).toBeUndefined();
  });

  it('stays under the byte ceiling with five hundred active tasks', () => {
    for (let index = 0; index < 500; index += 1) {
      addTask(`t-${index}`, 'p1', `Task ${index}`, {
        dueDate: index % 2 === 0 ? past : null,
        status: index % 5 === 0 ? 'COMPLETE' : 'TODO',
      });
    }
    const descriptor = buildWorkspaceContextDescriptor(db, { now: NOW });
    const bytes = utf8ByteLength(JSON.stringify(descriptor));
    expect(bytes).toBeLessThanOrEqual(WORKSPACE_CONTEXT_BYTE_CEILING);
    expect(descriptor.workspace?.overdueTasks).toBeGreaterThan(0);
    expect(descriptor.truncation).toBeUndefined();
  });

  it('declares truncation instead of silently dropping large include lists', () => {
    for (let index = 0; index < 400; index += 1) {
      addClient(`cx-${index}`, `Client ${index} with a deliberately long display name for sizing`);
      addProject(`px-${index}`, `cx-${index}`, `Project ${index} with a deliberately long name`);
    }
    const descriptor = buildWorkspaceContextDescriptor(db, {
      filters: { include: ['clients', 'projects'] },
      now: NOW,
    });
    expect(descriptor.truncation?.applied).toBe(true);
    expect(descriptor.truncation?.trimmed.length).toBeGreaterThan(0);
    const bytes = utf8ByteLength(JSON.stringify(descriptor));
    expect(bytes).toBeLessThanOrEqual(WORKSPACE_CONTEXT_BYTE_CEILING);
  });
});

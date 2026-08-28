/**
 * Read-only workspace table fingerprints for MCP diagnostic assertions (C124).
 *
 * Covers tables coordination and workspace writes touch — not auth metadata such as
 * agent_credentials.last_used_at.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';

const WORKSPACE_TABLES: ReadonlyArray<{ table: string; stampColumn: string }> = [
  { table: 'clients', stampColumn: 'updated_at' },
  { table: 'projects', stampColumn: 'updated_at' },
  { table: 'tasks', stampColumn: 'updated_at' },
  { table: 'agent_handoffs', stampColumn: 'updated_at' },
  { table: 'agent_handoff_notes', stampColumn: 'at' },
  { table: 'signal_posts', stampColumn: 'updated_at' },
  { table: 'integration_events', stampColumn: 'created_at' },
];

export function workspaceDataChecksum(db: Db): string {
  const parts: string[] = [];
  for (const { table, stampColumn } of WORKSPACE_TABLES) {
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    parts.push(`${table}:count=${countRow.count}`);
    const stampRow = db
      .prepare(`SELECT COALESCE(MAX(${stampColumn}), '') AS stamp FROM ${table}`)
      .get() as { stamp: string };
    parts.push(`${table}:stamp=${stampRow.stamp ?? ''}`);
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

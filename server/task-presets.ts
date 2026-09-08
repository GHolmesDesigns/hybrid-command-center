import type { Db } from './db.ts';
import {
  taskFilterSchema,
  type TaskFilterPreset,
  type TaskPresetInput,
} from '../shared/task-filters.ts';

type Row = {
  id: string;
  name: string;
  scope: 'shared' | 'operator';
  operator_session_hash: string | null;
  filters_json: string;
  created_at: string;
  updated_at: string;
};

const map = (row: Row): TaskFilterPreset => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  filters: taskFilterSchema.parse(JSON.parse(row.filters_json)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function listTaskPresets(db: Db, sessionHash: string | null) {
  const rows = db
    .prepare(
      `SELECT * FROM task_filter_presets WHERE scope='shared' OR (scope='operator' AND operator_session_hash=?) ORDER BY name COLLATE NOCASE`,
    )
    .all(sessionHash) as Row[];
  const chosen = new Map<string, Row>();
  for (const row of rows)
    if (!chosen.has(row.name) || row.scope === 'operator') chosen.set(row.name, row);
  return [...chosen.values()].map(map);
}

export function saveTaskPreset(
  db: Db,
  input: TaskPresetInput,
  sessionHash: string | null,
  id: string,
  now: string,
) {
  const scope = input.scope === 'operator' && sessionHash ? 'operator' : 'shared';
  db.prepare(
    `INSERT INTO task_filter_presets(id,name,scope,operator_session_hash,filters_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(name,scope,operator_session_hash) DO UPDATE SET filters_json=excluded.filters_json,updated_at=excluded.updated_at`,
  ).run(
    id,
    input.name,
    scope,
    scope === 'operator' ? sessionHash : null,
    JSON.stringify(input.filters),
    now,
    now,
  );
  return map(
    db
      .prepare(
        `SELECT * FROM task_filter_presets WHERE name=? AND scope=? AND operator_session_hash IS ?`,
      )
      .get(input.name, scope, scope === 'operator' ? sessionHash : null) as Row,
  );
}

export function deleteTaskPreset(db: Db, presetId: string, sessionHash: string | null) {
  const result = db
    .prepare(
      `DELETE FROM task_filter_presets WHERE id=? AND (scope='shared' OR (scope='operator' AND operator_session_hash=?))`,
    )
    .run(presetId, sessionHash);
  return result.changes > 0;
}

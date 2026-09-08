import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './db.ts';
import { deleteTaskPreset, listTaskPresets, saveTaskPreset } from './task-presets.ts';
import type { TaskFilter } from '../shared/task-filters.ts';

let db: Db;
const filters: TaskFilter = {
  clients: [],
  projects: [],
  priorities: ['HIGH'],
  statuses: [],
  types: [],
  focus: [],
  tags: [],
  search: '',
};

beforeEach(() => {
  db = createDb(':memory:');
});

describe('task filter presets', () => {
  it('lets an operator preset override a shared preset with the same name', () => {
    saveTaskPreset(
      db,
      { name: 'Urgent work', filters, scope: 'shared' },
      null,
      'shared-id',
      '2026-09-08T00:00:00.000Z',
    );
    saveTaskPreset(
      db,
      { name: 'Urgent work', filters: { ...filters, priorities: ['URGENT'] }, scope: 'operator' },
      'operator-a',
      'operator-id',
      '2026-09-08T00:00:01.000Z',
    );

    expect(listTaskPresets(db, 'operator-a')[0].filters.priorities).toEqual(['URGENT']);
    expect(listTaskPresets(db, 'operator-b')[0].filters.priorities).toEqual(['HIGH']);
  });

  it('cannot delete another operator preset', () => {
    saveTaskPreset(
      db,
      { name: 'Mine', filters, scope: 'operator' },
      'operator-a',
      'preset-id',
      '2026-09-08T00:00:00.000Z',
    );
    expect(deleteTaskPreset(db, 'preset-id', 'operator-b')).toBe(false);
    expect(listTaskPresets(db, 'operator-a')).toHaveLength(1);
  });
});

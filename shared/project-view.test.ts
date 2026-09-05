import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PROJECT_PRESENTATION,
  LIVE_PROJECT_STATUSES,
  PROJECT_PRESENTATIONS,
  parseLiveProjectStatuses,
  serializeLiveProjectStatuses,
} from './project-view.ts';

describe('project view vocabulary', () => {
  it('ships grid as the canonical presentation and five live statuses', () => {
    expect(CANONICAL_PROJECT_PRESENTATION).toBe('grid');
    expect(PROJECT_PRESENTATIONS).toEqual(['grid', 'list']);
    expect(LIVE_PROJECT_STATUSES).toEqual([
      'PLANNING',
      'BUILDING',
      'ACTIVE',
      'ON_HOLD',
      'COMPLETE',
    ]);
  });

  it('parses statuses with OR-ready multi-select semantics and drops unknowns', () => {
    expect(parseLiveProjectStatuses(null)).toEqual([]);
    expect(parseLiveProjectStatuses('')).toEqual([]);
    expect(parseLiveProjectStatuses('ACTIVE,PLANNING,ARCHIVED,ACTIVE,nope')).toEqual([
      'PLANNING',
      'ACTIVE',
    ]);
    expect(parseLiveProjectStatuses('BUILDING,ACTIVE')).toEqual(['BUILDING', 'ACTIVE']);
    expect(parseLiveProjectStatuses(' COMPLETE , ON_HOLD ')).toEqual(['ON_HOLD', 'COMPLETE']);
  });

  it('serializes in canonical order so toggle order does not reshuffle the URL', () => {
    expect(serializeLiveProjectStatuses(['COMPLETE', 'PLANNING', 'BUILDING', 'ACTIVE'])).toBe(
      'PLANNING,BUILDING,ACTIVE,COMPLETE',
    );
    expect(serializeLiveProjectStatuses([])).toBe('');
  });
});

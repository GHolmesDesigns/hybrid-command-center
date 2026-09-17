import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { checkCaps, getUsageForDay, incrementTokens, incrementTurn } from './daily-usage.ts';

describe('assistant daily usage', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('tracks turns and tokens for the current day', () => {
    expect(getUsageForDay(db)).toEqual({
      day: new Date().toISOString().slice(0, 10),
      turnCount: 0,
      tokenCount: 0,
    });
    expect(incrementTurn(db).turnCount).toBe(1);
    expect(incrementTokens(db, 250).tokenCount).toBe(250);
    expect(incrementTokens(db, 0).tokenCount).toBe(250);
  });

  it('reports turn and token cap violations', () => {
    incrementTurn(db);
    expect(checkCaps(db, { dailyTurnCap: 1, dailyTokenCap: 1000 }).ok).toBe(false);
    expect(checkCaps(db, { dailyTurnCap: 5, dailyTokenCap: 10 }, 20)).toMatchObject({
      ok: false,
      reason: 'token_cap',
    });
    expect(checkCaps(db, { dailyTurnCap: 5, dailyTokenCap: 1000 }).ok).toBe(true);
    expect(checkCaps(db, { dailyTurnCap: 1, dailyTokenCap: 1000 })).toMatchObject({
      ok: false,
      reason: 'turn_cap',
    });
  });
});

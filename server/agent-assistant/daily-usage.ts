import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import type { CommandAiAssistantSettings } from '../../shared/command-ai-assistant.ts';

export type DailyUsage = {
  day: string;
  turnCount: number;
  tokenCount: number;
};

const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

export function getUsageForDay(db: Db, day = dayKey()): DailyUsage {
  const row = db
    .prepare('SELECT usage_day, turn_count, token_count FROM assistant_daily_usage WHERE usage_day=?')
    .get(day) as { usage_day: string; turn_count: number; token_count: number } | undefined;
  return row
    ? { day: row.usage_day, turnCount: row.turn_count, tokenCount: row.token_count }
    : { day, turnCount: 0, tokenCount: 0 };
}

export function incrementTurn(db: Db, day = dayKey()): DailyUsage {
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO assistant_daily_usage(usage_day, turn_count, token_count)
       VALUES(?, 1, 0)
       ON CONFLICT(usage_day) DO UPDATE SET turn_count = turn_count + 1`,
    ).run(day);
    return getUsageForDay(db, day);
  });
}

export function incrementTokens(db: Db, tokens: number, day = dayKey()): DailyUsage {
  if (tokens <= 0) return getUsageForDay(db, day);
  return transaction(db, () => {
    db.prepare(
      `INSERT INTO assistant_daily_usage(usage_day, turn_count, token_count)
       VALUES(?, 0, ?)
       ON CONFLICT(usage_day) DO UPDATE SET token_count = token_count + ?`,
    ).run(day, tokens, tokens);
    return getUsageForDay(db, day);
  });
}

export type CapCheckResult =
  | { ok: true }
  | { ok: false; reason: 'turn_cap' | 'token_cap'; message: string };

export function checkCaps(
  db: Db,
  settings: Pick<CommandAiAssistantSettings, 'dailyTurnCap' | 'dailyTokenCap'>,
  extraTokens = 0,
  now = new Date(),
): CapCheckResult {
  const usage = getUsageForDay(db, dayKey(now));
  if (usage.turnCount >= settings.dailyTurnCap) {
    return {
      ok: false,
      reason: 'turn_cap',
      message: `Stopped at the daily turn limit (${settings.dailyTurnCap}).`,
    };
  }
  if (usage.tokenCount + extraTokens > settings.dailyTokenCap) {
    return {
      ok: false,
      reason: 'token_cap',
      message: `Stopped at the daily token limit (${settings.dailyTokenCap}).`,
    };
  }
  return { ok: true };
}

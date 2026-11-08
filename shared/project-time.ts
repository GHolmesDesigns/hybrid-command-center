export type BudgetStatus = 'NORMAL' | 'WARNING' | 'OVER' | 'UNSET';

export function projectTimeBudgetStatus(
  loggedSeconds: number,
  budgetMinutes: number | null | undefined,
): BudgetStatus {
  if (budgetMinutes === null || budgetMinutes === undefined || budgetMinutes <= 0) return 'UNSET';
  const budgetSeconds = budgetMinutes * 60;
  if (loggedSeconds > budgetSeconds) return 'OVER';
  return loggedSeconds >= budgetSeconds * 0.8 ? 'WARNING' : 'NORMAL';
}

export function parseLocalParts(date: string, time: string): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) throw new Error('Enter a valid start or end date and time.');
  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  const value = Date.UTC(+year, +month - 1, +day, +hour, +minute);
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== +year ||
    parsed.getUTCMonth() !== +month - 1 ||
    parsed.getUTCDate() !== +day ||
    +hour > 23 ||
    +minute > 59
  )
    throw new Error('Enter a valid start or end date and time.');
  return value;
}

function localEpochAt(instant: number, zone: string): number {
  const values = new Map(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')),
    Number(values.get('minute')),
  );
}

/**
 * Resolve a wall-clock minute in an IANA zone without allowing JS to silently normalize a DST
 * gap. Ambiguous fall-back minutes need the caller to choose which occurrence they mean.
 */
export function resolveLocalDateTime(
  date: string,
  time: string,
  zone: string,
  ambiguity?: 'earlier' | 'later',
): Date {
  const localEpoch = parseLocalParts(date, time);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone });
  } catch {
    throw new Error('Choose a valid operator time zone.');
  }
  formatter.format(0);

  const offsets = new Set<number>();
  for (let delta = -48 * 60; delta <= 48 * 60; delta += 30) {
    const sample = localEpoch + delta * 60_000;
    offsets.add(localEpochAt(sample, zone) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => localEpoch - offset)
    .filter((instant) => localEpochAt(instant, zone) === localEpoch)
    .sort((a, b) => a - b);
  if (candidates.length === 0)
    throw new Error(
      'That local time does not exist because the clocks change. Choose another time.',
    );
  if (candidates.length > 1 && !ambiguity)
    throw new Error(
      'That local time occurs twice because the clocks change. Choose the earlier or later time.',
    );
  return new Date(
    candidates.length > 1 && ambiguity === 'later' ? candidates.at(-1)! : candidates[0]!,
  );
}

export function formatDuration(seconds: number): string {
  const wholeMinutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(wholeMinutes / 60)}h ${String(wholeMinutes % 60).padStart(2, '0')}m`;
}

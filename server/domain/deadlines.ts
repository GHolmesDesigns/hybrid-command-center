import { endOfDay, isAfter, isSameDay, startOfDay, addDays, parseISO } from 'date-fns';

const localDate = (value: string) => parseISO(value);

export function isOverdue(dueDate?: string | null, status?: string, now = new Date()) {
  if (!dueDate || status === 'COMPLETE') return false;
  return isAfter(startOfDay(now), startOfDay(localDate(dueDate)));
}
export function isDueToday(dueDate?: string | null, now = new Date()) {
  return Boolean(dueDate && isSameDay(localDate(dueDate!), now));
}
export function isDueNextSevenDays(dueDate?: string | null, now = new Date()) {
  if (!dueDate) return false;
  const due = localDate(dueDate);
  return isAfter(due, endOfDay(now)) && !isAfter(due, endOfDay(addDays(now, 7)));
}

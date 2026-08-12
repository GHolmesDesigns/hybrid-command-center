import { format, parseISO } from 'date-fns';

export const formatDate = (value: string) => {
  try {
    return format(parseISO(value), 'MMM d, yyyy');
  } catch {
    return value;
  }
};

/**
 * A stored UTC timestamp as a local date and time. Used where *when* something happened
 * matters to the minute — an import receipt — rather than only on which day.
 */
export const formatDateTime = (value: string) => {
  try {
    return format(parseISO(value), 'MMM d, yyyy · h:mm a');
  } catch {
    return value;
  }
};

export const formatDataAge = (elapsedMs: number) => {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
};

export const dateInput = (value?: string) => value?.slice(0, 10) || '';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((x) => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

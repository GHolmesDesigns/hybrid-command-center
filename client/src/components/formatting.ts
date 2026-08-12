import { format, parseISO } from 'date-fns';

export function pageName(path: string) {
  if (path.startsWith('/clients')) return 'Clients';
  if (path.startsWith('/projects')) return 'Projects';
  if (path.startsWith('/kanban')) return 'Status';
  if (path.startsWith('/settings')) return 'Settings';
  return 'Dashboard';
}

export const formatDate = (value: string) => {
  try {
    return format(parseISO(value), 'MMM d, yyyy');
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

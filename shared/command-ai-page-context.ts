export const COMMAND_AI_PAGE_CONTEXT_SUBJECT_TYPES = [
  'client',
  'project',
  'task',
  'signal_post',
] as const;
export type CommandAiPageContextSubjectType =
  (typeof COMMAND_AI_PAGE_CONTEXT_SUBJECT_TYPES)[number];

/** Bounded, serializable page snapshot for a future agent request — not a conversation message. */
export type CommandAiPageContext = {
  pathname: string;
  search: string;
  label: string;
  subjectType: CommandAiPageContextSubjectType | null;
  subjectId: string | null;
  capturedAt: string;
};

const normalizePath = (pathname: string) => pathname.replace(/\/+$/, '') || '/';

/** Workspace pages may attach context; agent and settings surfaces do not. */
export function commandAiPageContextEligible(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (path === '/settings') return false;
  if (path === '/agents/conversations') return false;
  if (path.startsWith('/agents/')) return false;
  return true;
}

export function commandAiPageContextSubject(pathname: string): {
  subjectType: CommandAiPageContextSubjectType | null;
  subjectId: string | null;
} {
  const parts = normalizePath(pathname).split('/').filter(Boolean);
  if (parts[0] === 'clients' && parts[1]) {
    return { subjectType: 'client', subjectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'projects' && parts[1]) {
    return { subjectType: 'project', subjectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'tasks' && parts[1]) {
    return { subjectType: 'task', subjectId: decodeURIComponent(parts[1]) };
  }
  return { subjectType: null, subjectId: null };
}

/** Human label from breadcrumb segments, omitting the Command Center root. */
export function formatCommandAiPageContextLabel(
  segments: readonly { label: string }[],
): string {
  const pageSegments = segments.slice(1);
  if (pageSegments.length === 0) {
    return segments[0]?.label ?? 'Current page';
  }
  return pageSegments.map((segment) => segment.label).join(' · ');
}

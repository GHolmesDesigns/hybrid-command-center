import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import {
  commandAiPageContextEligible,
  commandAiPageContextSubject,
  formatCommandAiPageContextLabel,
  type CommandAiPageContext,
} from '../../shared/command-ai-page-context.ts';
import { breadcrumbsFor, type BreadcrumbData } from './components/breadcrumbs';

export function useCommandAiPageContext(data: BreadcrumbData): CommandAiPageContext | null {
  const { pathname, search } = useLocation();
  return useMemo(() => {
    if (!commandAiPageContextEligible(pathname)) return null;
    const segments = breadcrumbsFor(pathname, data, undefined, search);
    const { subjectType, subjectId } = commandAiPageContextSubject(pathname);
    return {
      pathname,
      search,
      label: formatCommandAiPageContextLabel(segments),
      subjectType,
      subjectId,
      capturedAt: new Date().toISOString(),
    };
  }, [pathname, search, data]);
}

/**
 * Route-aware breadcrumb trail. Each route in `BREADCRUMB_ROUTES` contributes one
 * labeled segment; the trail is the matching prefixes of the current path plus a
 * stable Command Center root. Adding a page is a table row — not a per-page crumb.
 *
 * Task detail is a modal, not a route, so it never appears here (issue #68, option a).
 */
export type BreadcrumbEntity = { id: string; name: string };
export type BreadcrumbProject = BreadcrumbEntity & {
  clientId: string;
  clientName?: string;
};

export type BreadcrumbData = {
  clients: readonly BreadcrumbEntity[];
  projects: readonly BreadcrumbProject[];
};

export type BreadcrumbSegment = {
  label: string;
  href: string;
  current: boolean;
};

export type BreadcrumbRoute = {
  path: string;
  label: string | ((params: Record<string, string>, data: BreadcrumbData) => string);
};

export const HOME_CRUMB_LABEL = 'Command Center';

export const BREADCRUMB_ROUTES: readonly BreadcrumbRoute[] = [
  { path: '/', label: 'Dashboard' },
  { path: '/clients', label: 'Clients' },
  {
    path: '/clients/:id',
    label: (params, data) =>
      data.clients.find((client) => client.id === params.id)?.name ?? 'Client',
  },
  { path: '/projects', label: 'Projects' },
  {
    path: '/projects/:id',
    label: (params, data) =>
      data.projects.find((project) => project.id === params.id)?.name ?? 'Project',
  },
  { path: '/kanban', label: 'Status' },
  { path: '/calendar', label: 'Calendar' },
  { path: '/signal', label: 'Signal' },
  { path: '/settings', label: 'Settings' },
];

const matchRoute = (pathname: string, route: BreadcrumbRoute): Record<string, string> | null => {
  if (route.path === '/') return pathname === '/' ? {} : null;
  const patternParts = route.path.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pattern = patternParts[i];
    const value = pathParts[i];
    if (pattern.startsWith(':')) params[pattern.slice(1)] = decodeURIComponent(value);
    else if (pattern !== value) return null;
  }
  return params;
};

const pathPrefixes = (pathname: string): string[] => {
  if (pathname === '/') return ['/'];
  const parts = pathname.split('/').filter(Boolean);
  const prefixes: string[] = [];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    prefixes.push(acc);
  }
  return prefixes;
};

const resolveLabel = (
  route: BreadcrumbRoute,
  params: Record<string, string>,
  data: BreadcrumbData,
) => (typeof route.label === 'function' ? route.label(params, data) : route.label);

const normalizePath = (pathname: string) => pathname.replace(/\/+$/, '') || '/';

export function breadcrumbsFor(
  pathname: string,
  data: BreadcrumbData,
  routes: readonly BreadcrumbRoute[] = BREADCRUMB_ROUTES,
): BreadcrumbSegment[] {
  const path = normalizePath(pathname);
  const matched: { href: string; label: string }[] = [];
  for (const prefix of pathPrefixes(path)) {
    const route = routes.find((candidate) => matchRoute(prefix, candidate) !== null);
    if (!route) continue;
    const params = matchRoute(prefix, route) ?? {};
    matched.push({ href: prefix, label: resolveLabel(route, params, data) });
  }
  const trail: BreadcrumbSegment[] = [
    { label: HOME_CRUMB_LABEL, href: '/', current: false },
    ...matched.map((item) => ({ ...item, current: false })),
  ];
  trail[trail.length - 1].current = true;
  return trail;
}

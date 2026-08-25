import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BreadcrumbTrail } from './components/BreadcrumbTrail';
import {
  BREADCRUMB_ROUTES,
  breadcrumbsFor,
  HOME_CRUMB_LABEL,
  type BreadcrumbData,
  type BreadcrumbRoute,
} from './components/breadcrumbs';

const empty: BreadcrumbData = { clients: [], projects: [] };
const data: BreadcrumbData = {
  clients: [{ id: 'c1', name: 'Acme', status: 'ACTIVE' }],
  projects: [
    {
      id: 'p1',
      name: 'Website Refresh',
      clientId: 'c1',
      clientName: 'Acme',
      status: 'ACTIVE',
    },
  ],
};

const labels = (
  pathname: string,
  lookup: BreadcrumbData = data,
  routes?: readonly BreadcrumbRoute[],
) => breadcrumbsFor(pathname, lookup, routes).map((segment) => segment.label);

describe('breadcrumbsFor', () => {
  it('starts from Command Center and names the dashboard on /', () => {
    expect(labels('/', empty)).toEqual([HOME_CRUMB_LABEL, 'Dashboard']);
    const trail = breadcrumbsFor('/', empty);
    expect(trail[0]).toMatchObject({ href: '/', current: false });
    expect(trail[1]).toMatchObject({ href: '/', current: true });
  });

  it('builds client and project trails from the route table and loaded names', () => {
    expect(labels('/clients/c1')).toEqual([HOME_CRUMB_LABEL, 'Clients', 'Acme']);
    expect(labels('/projects/p1')).toEqual([HOME_CRUMB_LABEL, 'Projects', 'Website Refresh']);
  });

  it('falls back while an entity is still missing from loaded data', () => {
    expect(labels('/clients/c1', empty)).toEqual([HOME_CRUMB_LABEL, 'Clients', 'Client']);
    expect(labels('/projects/p1', empty)).toEqual([HOME_CRUMB_LABEL, 'Projects', 'Project']);
  });

  it('marks only the last segment current and keeps ancestors as hrefs', () => {
    const trail = breadcrumbsFor('/clients/c1', data);
    expect(trail.filter((segment) => segment.current)).toHaveLength(1);
    expect(trail[0]).toMatchObject({ href: '/', current: false });
    expect(trail[1]).toMatchObject({ href: '/clients', current: false });
    expect(trail[2]).toMatchObject({ href: '/clients/c1', current: true, label: 'Acme' });
  });

  it('picks up a new route from the table with no page-specific breadcrumb code', () => {
    // A route the table does not carry, so this keeps testing the mechanism rather than one of
    // the routes that now happens to be registered.
    const routes = [...BREADCRUMB_ROUTES, { path: '/reports', label: 'Reports' }];
    expect(labels('/reports', empty, routes)).toEqual([HOME_CRUMB_LABEL, 'Reports']);
    expect(breadcrumbsFor('/reports', empty, routes)[1]).toMatchObject({
      href: '/reports',
      current: true,
    });
  });

  it('trails the calendar from the real table', () => {
    expect(labels('/calendar', empty)).toEqual([HOME_CRUMB_LABEL, 'Calendar']);
    expect(breadcrumbsFor('/calendar', empty)[1]).toMatchObject({
      href: '/calendar',
      current: true,
    });
  });

  it('adds a validated project context to Status and preserves all current filters', () => {
    const trail = breadcrumbsFor(
      '/status',
      data,
      BREADCRUMB_ROUTES,
      '?project=p1&priority=HIGH%2CURGENT&type=GRAPHICS',
    );

    expect(trail).toEqual([
      { label: HOME_CRUMB_LABEL, href: '/', current: false },
      { label: 'Projects', href: '/projects', current: false },
      { label: 'Website Refresh', href: '/projects/p1', current: false },
      {
        label: 'Status',
        href: '/status?project=p1&priority=HIGH%2CURGENT&type=GRAPHICS',
        current: true,
      },
    ]);
  });

  it('keeps Status top-level when the project context is absent or not one exact live project', () => {
    const archivedProject: BreadcrumbData = {
      ...data,
      projects: [{ ...data.projects[0], id: 'archived', status: 'ARCHIVED' }],
    };
    const archivedClient: BreadcrumbData = {
      clients: [{ ...data.clients[0], status: 'ARCHIVED' }],
      projects: data.projects,
    };
    const mergedClient: BreadcrumbData = {
      clients: [
        {
          ...data.clients[0],
          mergedInto: { id: 'c2', name: 'Survivor', mergedAt: '2026-08-25T12:00:00.000Z' },
        },
      ],
      projects: data.projects,
    };

    for (const [lookup, search] of [
      [data, ''],
      [data, '?project=unknown'],
      [data, '?project=p1%2Cp2'],
      [archivedProject, '?project=archived'],
      [archivedClient, '?project=p1'],
      [mergedClient, '?project=p1'],
    ] as const) {
      expect(breadcrumbsFor('/status', lookup, BREADCRUMB_ROUTES, search)).toEqual([
        { label: HOME_CRUMB_LABEL, href: '/', current: false },
        { label: 'Status', href: `/status${search}`, current: true },
      ]);
    }
  });

  it('ignores a trailing slash and does not invent a task-detail segment', () => {
    expect(labels('/projects/p1/')).toEqual(labels('/projects/p1'));
    expect(labels('/projects/p1')).not.toContain('Task');
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const renderTrail = (path: string, lookup: BreadcrumbData = data) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <BreadcrumbTrail clients={lookup.clients} projects={lookup.projects} />
      <LocationProbe />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );

describe('BreadcrumbTrail', () => {
  it('exposes a semantic nav list with the current page marked', () => {
    renderTrail('/clients/c1');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('Acme')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('link', { name: 'Acme' })).toBeNull();
    expect(within(nav).getByRole('link', { name: HOME_CRUMB_LABEL })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Clients' })).toHaveAttribute('href', '/clients');
  });

  it('navigates ancestor segments by click through real links', () => {
    renderTrail('/projects/p1');
    fireEvent.click(screen.getByRole('link', { name: 'Projects' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects');
  });

  it('links a filtered Status view back through its named project', () => {
    renderTrail('/status?project=p1&filter=week');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(within(nav).getByRole('link', { name: 'Website Refresh' })).toHaveAttribute(
      'href',
      '/projects/p1',
    );
    expect(within(nav).getByText('Status')).toHaveAttribute('aria-current', 'page');
  });

  it('puts the full name on hover and focus via title', () => {
    renderTrail('/projects/p1');
    expect(screen.getByText('Website Refresh')).toHaveAttribute('title', 'Website Refresh');
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('title', 'Projects');
  });
});

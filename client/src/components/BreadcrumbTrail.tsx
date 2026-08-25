import { ChevronRight } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { breadcrumbsFor, type BreadcrumbData } from './breadcrumbs';

export function BreadcrumbTrail({ clients, projects }: BreadcrumbData) {
  const { pathname, search } = useLocation();
  const segments = breadcrumbsFor(pathname, { clients, projects }, undefined, search);
  return (
    <nav className="crumb" aria-label="Breadcrumb">
      <ol>
        {segments.map((segment, index) => (
          <li key={`${segment.href}:${segment.label}:${index}`}>
            {index > 0 && <ChevronRight aria-hidden="true" />}
            {segment.current ? (
              <span aria-current="page" title={segment.label}>
                {segment.label}
              </span>
            ) : (
              <Link to={segment.href} title={segment.label}>
                {segment.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

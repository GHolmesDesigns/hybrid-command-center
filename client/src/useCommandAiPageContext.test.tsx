import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useCommandAiPageContext } from './useCommandAiPageContext';
import type { BreadcrumbData } from './components/breadcrumbs';

const emptyData: BreadcrumbData = {
  clients: [],
  projects: [],
};

function renderPageContext(path: string, data: BreadcrumbData = emptyData) {
  return renderHook(() => useCommandAiPageContext(data), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
  });
}

describe('useCommandAiPageContext', () => {
  it('returns null on pages that should not carry page context', () => {
    expect(renderPageContext('/settings').result.current).toBeNull();
    expect(renderPageContext('/agents/conversations').result.current).toBeNull();
  });

  it('captures project subject metadata on workspace detail routes', () => {
    const data: BreadcrumbData = {
      ...emptyData,
      projects: [
        {
          id: 'p1',
          name: 'Website Refresh',
          clientId: 'c1',
          clientName: 'Acme Studio',
          status: 'ACTIVE',
        },
      ],
      clients: [{ id: 'c1', name: 'Acme Studio', status: 'ACTIVE' }],
    };
    const { result } = renderPageContext('/projects/p1', data);
    expect(result.current).toMatchObject({
      pathname: '/projects/p1',
      subjectType: 'project',
      subjectId: 'p1',
    });
    expect(result.current?.label).toContain('Website Refresh');
  });
});

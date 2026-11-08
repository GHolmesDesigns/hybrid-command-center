import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProjectTimeTab } from './components/ProjectTimeTab';
import type { Project, TimeCategory, TimeEntry } from '../../shared/types';

const mocks = vi.hoisted(() => ({ api: vi.fn(), send: vi.fn() }));
vi.mock('./api', () => ({ api: mocks.api, send: mocks.send }));

const project = {
  id: 'project-1',
  name: 'Identity',
  timeBudgetMinutes: 120,
  revision: 1,
} as Project;
const category: TimeCategory = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Client work',
  position: 0,
  isDefault: true,
  selectable: true,
};
const entry: TimeEntry = {
  id: 'entry-1',
  projectId: project.id,
  projectName: project.name,
  categoryId: category.id,
  categoryName: category.name,
  startedAt: '2026-01-02T09:00:00.000Z',
  endedAt: '2026-01-02T11:00:00.000Z',
  durationSeconds: 7200,
  notes: 'Planning',
  createdAt: '2026-01-02T11:00:00.000Z',
  updatedAt: '2026-01-02T11:00:00.000Z',
  revision: 1,
};

describe('ProjectTimeTab', () => {
  beforeEach(() => {
    mocks.api.mockImplementation((path: string) => {
      if (path === '/settings/time-zone') return Promise.resolve({ timeZone: 'UTC' });
      if (path.endsWith('/time/categories')) return Promise.resolve([category]);
      if (path.endsWith('/time/entries') || path.includes('/time/entries?'))
        return Promise.resolve([entry]);
      if (path.endsWith('/time/summary'))
        return Promise.resolve({
          projectId: project.id,
          totalSeconds: 7200,
          entryCount: 1,
          budgetMinutes: 120,
          budgetStatus: 'WARNING',
          byTask: [],
          byCategory: [
            {
              categoryId: category.id,
              categoryName: category.name,
              durationSeconds: 7200,
              entries: 1,
            },
          ],
        });
      throw new Error(`Unexpected API read ${path}`);
    });
    mocks.send.mockResolvedValue({});
  });

  it('shows project totals and entries, then opens the manual entry form', async () => {
    render(
      <ProjectTimeTab
        project={project}
        tasks={[]}
        flash={vi.fn()}
        refresh={vi.fn(async () => {})}
      />,
    );
    expect(await screen.findByText('Time entries')).toBeVisible();
    expect(screen.getAllByText('2h 00m')[0]).toBeVisible();
    expect(screen.getByText('Planning')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Log time/ }));
    expect(screen.getByRole('dialog', { name: 'Log time' })).toBeVisible();
    expect(within(screen.getByRole('dialog')).getByLabelText('Category')).toHaveValue(category.id);
  });

  it('exports only the currently loaded filtered entries with operator-local columns', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:time');
    render(
      <ProjectTimeTab
        project={project}
        tasks={[]}
        flash={vi.fn()}
        refresh={vi.fn(async () => {})}
      />,
    );
    await screen.findByText('Time entries');
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createUrl).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text/csv;charset=utf-8' }),
    );
    click.mockRestore();
    createUrl.mockRestore();
  });

  it('saves budgets, time zone, categories, edits, filters, and deletions from their controls', async () => {
    const flash = vi.fn();
    const refresh = vi.fn(async () => {});
    const own = { ...category, id: '00000000-0000-4000-8000-000000000002', projectId: project.id };
    const ownTwo = {
      ...own,
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Research',
      position: 1,
    };
    const task = { id: 'task-1', projectId: project.id, title: 'Review' };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.send.mockImplementation((path: string) =>
      Promise.resolve(path === '/settings/time-zone' ? { timeZone: 'America/New_York' } : {}),
    );
    mocks.api.mockImplementation((path: string) => {
      if (path === '/settings/time-zone') return Promise.resolve({ timeZone: 'UTC' });
      if (path.endsWith('/time/categories')) return Promise.resolve([category, own, ownTwo]);
      if (path.includes('/time/entries')) return Promise.resolve([entry]);
      if (path.endsWith('/time/summary'))
        return Promise.resolve({
          projectId: project.id,
          totalSeconds: 7200,
          entryCount: 1,
          budgetMinutes: 120,
          budgetStatus: 'OVER',
          byTask: [{ taskId: task.id, taskTitle: task.title, durationSeconds: 7200, entries: 1 }],
          byCategory: [],
        });
      throw new Error(`Unexpected API read ${path}`);
    });
    const { container } = render(
      <ProjectTimeTab project={project} tasks={[task as never]} flash={flash} refresh={refresh} />,
    );
    await screen.findByText('Time entries');
    expect(container.querySelector('.time-budget-status.warning')).toHaveTextContent(
      'Approaching budget',
    );
    expect(screen.getAllByText('Review')[0]).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(`/projects/${project.id}/time-budget`, 'PATCH', {
        minutes: 120,
        revision: project.revision,
      }),
    );
    fireEvent.change(screen.getByLabelText('Operator time zone'), {
      target: { value: 'America/New_York' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save time zone' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith('/settings/time-zone', 'PUT', {
        timeZone: 'America/New_York',
      }),
    );

    fireEvent.change(screen.getByLabelText('Task'), { target: { value: task.id } });
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining(`taskId=${task.id}`)),
    );
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining('from=2026-01-01')),
    );

    fireEvent.click(screen.getByRole('button', { name: /Edit time entry/ }));
    const dialog = screen.getByRole('dialog', { name: 'Edit time entry' });
    fireEvent.change(within(dialog).getByLabelText('Notes'), { target: { value: 'Revised' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        `/projects/${project.id}/time/entries/${entry.id}`,
        'PATCH',
        expect.objectContaining({
          notes: 'Revised',
          revision: entry.revision,
        }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete time entry' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        `/projects/${project.id}/time/entries/${entry.id}`,
        'DELETE',
        { revision: entry.revision },
      ),
    );

    fireEvent.change(screen.getByLabelText('New category'), { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(`/projects/${project.id}/time/categories`, 'POST', {
        name: 'Planning',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Research up' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        `/projects/${project.id}/time/categories/order`,
        'PUT',
        { categoryIds: [ownTwo.id, own.id] },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive Research' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(
        `/projects/${project.id}/time/categories/${ownTwo.id}/archive`,
        'POST',
      ),
    );
    expect(refresh).toHaveBeenCalled();
    expect(flash).toHaveBeenCalledWith('Project time budget saved.');
    confirm.mockRestore();
  });

  it('shows load failures and still permits a budget update', async () => {
    const flash = vi.fn();
    mocks.api.mockRejectedValueOnce(new Error('Network unavailable'));
    render(
      <ProjectTimeTab project={project} tasks={[]} flash={flash} refresh={vi.fn(async () => {})} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(flash).toHaveBeenCalledWith('Project time budget saved.'));
  });
});

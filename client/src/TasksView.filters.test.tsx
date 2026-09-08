import { MemoryRouter } from 'react-router-dom';
import {
  fireEvent,
  render,
  screen,
  describe,
  expect,
  it,
  task,
  client,
  project,
} from './App.test-setup';
import { TasksView } from './components/TasksView';

describe('TasksView filters', () => {
  it('filters the picker from shareable URL state and constrains projects by client', () => {
    const acme = client('client-acme', 'Acme');
    const north = project('project-north', 'North campaign', 'ACTIVE', { clientId: acme.id });
    const other = project('project-other', 'Other work', 'ACTIVE', { clientId: 'client-other' });
    render(
      <MemoryRouter initialEntries={['/tasks?client=client-acme&priority=URGENT']}>
        <TasksView
          clients={[acme, client('client-other', 'Other')]}
          projects={[north, other]}
          tags={[]}
          tasks={[
            task('urgent', 'Urgent task', {
              clientId: acme.id,
              projectId: north.id,
              priority: 'URGENT',
            }),
            task('ordinary', 'Ordinary task', {
              clientId: acme.id,
              projectId: north.id,
              priority: 'LOW',
            }),
            task('other', 'Other task', {
              clientId: 'client-other',
              projectId: other.id,
              priority: 'URGENT',
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Urgent task')).toBeVisible();
    expect(screen.queryByText('Ordinary task')).toBeNull();
    expect(screen.queryByText('Other task')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Client: Acme' }));
    expect(screen.getByRole('checkbox', { name: 'Acme' })).toBeChecked();
    expect(screen.getByText('1')).toBeVisible();
  });

  it('supports the remaining filter dimensions and clears them without losing timer controls', () => {
    const acme = client('client-acme', 'Acme');
    const north = project('project-north', 'North campaign', 'ACTIVE', { clientId: acme.id });
    const tag = { id: 'tag-video', name: 'Video', color: '#123456' };
    render(
      <MemoryRouter>
        <TasksView
          clients={[acme]}
          projects={[north]}
          tags={[tag]}
          tasks={[
            task('video', 'Video kickoff', {
              projectId: north.id,
              clientId: acme.id,
              taskType: 'VIDEO',
              blocked: true,
              overdue: true,
              tags: [tag],
            }),
            task('plain', 'Plain task', {
              projectId: north.id,
              clientId: acme.id,
              taskType: undefined,
              dueDate: undefined,
            }),
          ]}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Task type: Any type' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Video' }));
    expect(screen.getByText('Video kickoff')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Focus: All tasks' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Blocked' }));
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    fireEvent.change(screen.getByPlaceholderText('Search task titles and tags…'), {
      target: { value: 'kickoff' },
    });
    expect(screen.getByText('Video kickoff')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByText('Plain task')).toBeVisible();
    fireEvent.click(screen.getByText('Plain task'));
    expect(screen.getByRole('button', { name: /^Start/ })).toBeEnabled();
  });
});

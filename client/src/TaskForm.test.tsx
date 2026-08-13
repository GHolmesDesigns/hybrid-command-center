import {
  fireEvent,
  render,
  screen,
  waitFor,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  branding,
  task,
  testState,
  requests,
  clickTopbarNewTask,
  projectSelect,
} from './App.test-setup';

describe('Task type selector', () => {
  const typeSelect = () => screen.getByLabelText('Type') as HTMLSelectElement;

  const openNewTaskForm = async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(branding.title);
    clickTopbarNewTask();
  };

  it('starts untyped and offers the studio vocabulary in reading order', async () => {
    await openNewTaskForm();

    expect(typeSelect().value).toBe('');
    expect([...typeSelect().options].map((option) => option.textContent)).toEqual([
      'No type',
      'Blog Post',
      'Video',
      'Social Post',
      'Graphics',
      'Scheduling',
      'QA / Brand Pass',
      'Admin',
      'Dev Work',
      'Other',
    ]);
  });

  it('sends the chosen type when the task is created', async () => {
    await openNewTaskForm();
    fireEvent.change(projectSelect(), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Draft the recap' } });
    fireEvent.change(typeSelect(), { target: { value: 'BLOG_POST' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'))).toBe(true),
    );
    const created = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'));
    expect(created?.body.taskType).toBe('BLOG_POST');
  });

  it('posts an empty type rather than omitting the key, so "No type" clears it', async () => {
    await openNewTaskForm();
    fireEvent.change(projectSelect(), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Untyped chore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'))).toBe(true),
    );
    const created = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'));
    expect(created?.body.taskType).toBe('');
  });

  it('opens an existing task in the edit form with its type already selected', async () => {
    testState.tasksPayload = [task('t1', 'Recap post', { taskType: 'BLOG_POST' })];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Recap post/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));

    expect(await screen.findByRole('heading', { name: 'Edit task' })).toBeVisible();
    expect(typeSelect().value).toBe('BLOG_POST');
  });

  it('types a task that has none and sends only the type', async () => {
    testState.tasksPayload = [task('t1', 'Legacy chore')];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Legacy chore/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    expect(typeSelect().value).toBe('');

    fireEvent.change(typeSelect(), { target: { value: 'GRAPHICS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PATCH' && r.url.endsWith('/api/tasks/t1'))).toBe(
        true,
      ),
    );
    const saved = requests.find((r) => r.method === 'PATCH' && r.url.endsWith('/api/tasks/t1'));
    expect(saved?.body.taskType).toBe('GRAPHICS');
  });
});

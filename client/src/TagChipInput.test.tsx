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

describe('Tag chip input', () => {
  const tagField = () => screen.getByLabelText('Add a tag');
  const type = (value: string) => fireEvent.change(tagField(), { target: { value } });
  const enter = () => fireEvent.keyDown(tagField(), { key: 'Enter' });
  const chipNames = () =>
    screen
      .getAllByRole('button', { name: /^Remove tag / })
      .map((button) => button.getAttribute('aria-label')?.replace('Remove tag ', ''));

  const openNewTaskForm = async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(branding.title);
    clickTopbarNewTask();
  };
  const createTaskNamed = (title: string) => {
    fireEvent.change(projectSelect(), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: title } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  };
  const attachRequests = () =>
    requests.filter((r) => r.method === 'POST' && /\/api\/tasks\/[^/]+\/tags$/.test(r.url));

  it('turns a typed name into a chip and creates the tag when the task is saved', async () => {
    await openNewTaskForm();
    type('Client review');
    enter();

    expect(chipNames()).toEqual(['Client review']);
    expect(tagField()).toHaveValue('');

    createTaskNamed('Draft the recap');

    await waitFor(() => expect(attachRequests().length).toBe(1));
    const created = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/tags'));
    expect(created?.body).toEqual({ name: 'Client review' });
    expect(attachRequests()[0].url).toBe('/api/tasks/created-task/tags');
    expect(attachRequests()[0].body).toEqual({ tagId: 'tag-1' });
  });

  it('reuses an existing global tag whatever the case or surrounding whitespace', async () => {
    testState.tagsPayload = [{ id: 'tag-brand', name: 'Brand system' }];
    await openNewTaskForm();
    type('   brand   SYSTEM  ');
    enter();

    // The stored spelling wins, so the shared tag is recognisable wherever it appears.
    expect(chipNames()).toEqual(['Brand system']);

    createTaskNamed('Refresh the deck');

    await waitFor(() => expect(attachRequests().length).toBe(1));
    expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/tags'))).toBe(false);
    expect(attachRequests()[0].body).toEqual({ tagId: 'tag-brand' });
  });

  it('ignores a repeat of a tag already chosen, in any case', async () => {
    await openNewTaskForm();
    type('Launch');
    enter();
    type('  launch ');
    enter();

    expect(chipNames()).toEqual(['Launch']);
  });

  it('commits on a comma and on blur, so a typed name is never quietly dropped', async () => {
    await openNewTaskForm();
    type('Video');
    fireEvent.keyDown(tagField(), { key: ',' });
    expect(chipNames()).toEqual(['Video']);

    type('Print');
    fireEvent.blur(tagField());
    expect(chipNames()).toEqual(['Video', 'Print']);
  });

  it('removes chips with the remove button and with Backspace on an empty field', async () => {
    await openNewTaskForm();
    for (const name of ['Video', 'Print', 'Social']) {
      type(name);
      enter();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Print' }));
    expect(chipNames()).toEqual(['Video', 'Social']);

    fireEvent.keyDown(tagField(), { key: 'Backspace' });
    expect(chipNames()).toEqual(['Video']);
  });

  it('leaves an existing task alone when its tags are untouched', async () => {
    testState.tagsPayload = [{ id: 'tag-brand', name: 'Brand system' }];
    testState.tasksPayload = [
      task('t1', 'Recap post', { tags: [{ id: 'tag-brand', name: 'Brand system' }] }),
    ];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Recap post/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    expect(chipNames()).toEqual(['Brand system']);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PATCH' && r.url.endsWith('/api/tasks/t1'))).toBe(
        true,
      ),
    );
    // Only the mount-time `GET /api/tags` touched the tag endpoints; nothing was rewritten.
    expect(requests.filter((r) => r.method !== 'GET' && r.url.includes('/tags'))).toEqual([]);
  });

  it('detaches a tag straight from the task detail view', async () => {
    testState.tagsPayload = [{ id: 'tag-brand', name: 'Brand system' }];
    testState.tasksPayload = [
      task('t1', 'Recap post', { tags: [{ id: 'tag-brand', name: 'Brand system' }] }),
    ];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Recap post/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag Brand system' }));

    await waitFor(() =>
      expect(
        requests.some(
          (r) => r.method === 'DELETE' && r.url.endsWith('/api/tasks/t1/tags/tag-brand'),
        ),
      ).toBe(true),
    );
  });
});

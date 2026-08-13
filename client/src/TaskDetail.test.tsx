import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  task,
  testState,
  requests,
} from './App.test-setup';

describe('Task detail inline editing', () => {
  const openTask = async (title: string) => {
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${title}`) }));
    expect(await screen.findByRole('heading', { name: 'Task details' })).toBeVisible();
  };
  const detail = () => within(screen.getByRole('dialog'));
  const taskPatches = () =>
    requests.filter((r) => r.method === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(r.url));

  it('orders progress, working text, labels, then dependencies', async () => {
    testState.tasksPayload = [task('t1', 'Recap post')];
    await openTask('Recap post');

    const sectionHeadings = detail()
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(sectionHeadings).toEqual([
      'Task details',
      'Checklist 0/0',
      'Notes',
      'Tags',
      'Dependencies',
    ]);
  });

  it('shows empty states that open editors for description, dates, and notes', async () => {
    testState.tasksPayload = [task('t1', 'Recap post')];
    await openTask('Recap post');

    expect(detail().getByRole('button', { name: 'Add a description' })).toBeVisible();
    expect(detail().getByRole('button', { name: 'Add due date' })).toBeVisible();
    expect(detail().getByRole('button', { name: 'Add start date' })).toBeVisible();
    expect(detail().getByRole('button', { name: 'Add notes' })).toBeVisible();
    expect(detail().getByRole('button', { name: 'Edit details' })).toBeVisible();
  });

  it('saves description on its own and leaves dates and notes untouched', async () => {
    testState.tasksPayload = [
      task('t1', 'Recap post', {
        description: 'Old copy',
        dueDate: '2026-09-01',
        notes: 'Private scratch',
      }),
    ];
    await openTask('Recap post');

    fireEvent.click(detail().getByRole('button', { name: 'Edit description' }));
    fireEvent.change(detail().getByLabelText('Description'), { target: { value: 'New copy' } });
    fireEvent.click(detail().getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(taskPatches()).toHaveLength(1));
    expect(taskPatches()[0].body).toEqual({ description: 'New copy' });
    expect(detail().getByText('New copy')).toBeVisible();
    expect(detail().getByRole('button', { name: 'Edit due date' })).toHaveTextContent(
      'Sep 1, 2026',
    );
    expect(detail().getByText('Private scratch')).toBeVisible();
  });

  it('saves due date, start date, and notes independently', async () => {
    testState.tasksPayload = [task('t1', 'Recap post')];
    await openTask('Recap post');

    fireEvent.click(detail().getByRole('button', { name: 'Add due date' }));
    fireEvent.change(detail().getByLabelText('Due date'), { target: { value: '2026-10-15' } });
    fireEvent.click(detail().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(taskPatches()).toHaveLength(1));
    expect(taskPatches()[0].body).toEqual({ dueDate: '2026-10-15' });

    fireEvent.click(detail().getByRole('button', { name: 'Add start date' }));
    fireEvent.change(detail().getByLabelText('Start date'), { target: { value: '2026-10-01' } });
    fireEvent.click(detail().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(taskPatches()).toHaveLength(2));
    expect(taskPatches()[1].body).toEqual({ startDate: '2026-10-01' });

    fireEvent.click(detail().getByRole('button', { name: 'Add notes' }));
    fireEvent.change(detail().getByLabelText('Notes'), { target: { value: 'Call the printer' } });
    fireEvent.click(detail().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(taskPatches()).toHaveLength(3));
    expect(taskPatches()[2].body).toEqual({ notes: 'Call the printer' });

    expect(detail().getByRole('button', { name: 'Edit due date' })).toHaveTextContent(
      'Oct 15, 2026',
    );
    expect(detail().getByRole('button', { name: 'Edit start date' })).toHaveTextContent(
      'Oct 1, 2026',
    );
    expect(detail().getByText('Call the printer')).toBeVisible();
  });

  it('restores the previous value on Cancel and Escape without persisting', async () => {
    testState.tasksPayload = [
      task('t1', 'Recap post', { description: 'Keep this', notes: 'Leave me' }),
    ];
    await openTask('Recap post');

    fireEvent.click(detail().getByRole('button', { name: 'Edit description' }));
    fireEvent.change(detail().getByLabelText('Description'), { target: { value: 'Throw away' } });
    fireEvent.click(detail().getByRole('button', { name: 'Cancel' }));
    expect(detail().getByText('Keep this')).toBeVisible();
    expect(detail().queryByLabelText('Description')).toBeNull();

    fireEvent.click(detail().getByRole('button', { name: 'Edit notes' }));
    fireEvent.change(detail().getByLabelText('Notes'), { target: { value: 'Also throw away' } });
    fireEvent.keyDown(detail().getByLabelText('Notes').closest('form')!, { key: 'Escape' });
    expect(detail().getByText('Leave me')).toBeVisible();
    expect(detail().queryByLabelText('Notes')).toBeNull();
    expect(taskPatches()).toEqual([]);
  });

  it('resets every editor when switching to another task', async () => {
    testState.tasksPayload = [
      task('t1', 'Recap post', { description: 'Alpha' }),
      task('t2', 'Deck refresh', { description: 'Beta' }),
    ];
    await openTask('Recap post');

    fireEvent.click(detail().getByRole('button', { name: 'Edit description' }));
    fireEvent.change(detail().getByLabelText('Description'), {
      target: { value: 'Unsaved alpha' },
    });
    fireEvent.click(detail().getByLabelText('Close'));

    fireEvent.click(await screen.findByRole('button', { name: /^Deck refresh/ }));
    expect(await screen.findByRole('heading', { name: 'Task details' })).toBeVisible();
    expect(detail().getByText('Beta')).toBeVisible();
    expect(detail().queryByLabelText('Description')).toBeNull();
    expect(detail().queryByText('Unsaved alpha')).toBeNull();
  });

  it('surfaces a save failure and keeps the editor open with the draft', async () => {
    testState.tasksPayload = [task('t1', 'Recap post')];
    testState.taskPatchError = 'Could not save.';
    await openTask('Recap post');

    fireEvent.click(detail().getByRole('button', { name: 'Add a description' }));
    fireEvent.change(detail().getByLabelText('Description'), { target: { value: 'Keep typing' } });
    fireEvent.click(detail().getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Could not save.')).toBeVisible();
    expect(detail().getByLabelText('Description')).toHaveValue('Keep typing');
    expect(detail().getByRole('button', { name: 'Save' })).toBeVisible();
  });
});

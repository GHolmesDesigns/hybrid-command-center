import {
  fireEvent,
  render,
  screen,
  waitFor,
  MemoryRouter,
  App,
  describe,
  expect,
  it,
  requests,
  task,
  testState,
  projects,
} from './App.test-setup';

describe('task-bound Start Time actions', () => {
  it('starts the selected task from a card using the operator timer without editing task data', async () => {
    testState.tasksPayload = [task('t1', 'Card task')];
    render(
      <MemoryRouter initialEntries={['/status']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start Time for Card task' }));

    await waitFor(() => {
      expect(
        requests.find(
          (request) =>
            request.url.endsWith('/api/operator-timer/switch') && request.method === 'POST',
        )?.body,
      ).toMatchObject({ projectId: 'p1', taskId: 't1' });
    });
    expect(
      requests.some(
        (request) => request.method === 'PATCH' && /\/api\/tasks\/t1$/.test(request.url),
      ),
    ).toBe(false);
  });

  it('starts the selected task from the global header using the same operator timer action', async () => {
    testState.tasksPayload = [task('t1', 'Header task')];
    render(
      <MemoryRouter initialEntries={['/countdown/t1']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start Time' }));

    await waitFor(() => {
      expect(
        requests.find(
          (request) =>
            request.url.endsWith('/api/operator-timer/switch') && request.method === 'POST',
        )?.body,
      ).toMatchObject({ projectId: 'p1', taskId: 't1' });
    });
    expect(
      requests.some(
        (request) => request.method === 'PATCH' && /\/api\/tasks\/t1$/.test(request.url),
      ),
    ).toBe(false);
  });

  it('does not start a second timer for a task that already owns the active timer', async () => {
    testState.tasksPayload = [task('t1', 'Already timing')];
    testState.operatorTimerPayload = {
      ...testState.operatorTimerPayload,
      state: 'RUNNING',
      taskId: 't1',
      timerId: 'timer-1',
    };
    render(
      <MemoryRouter initialEntries={['/status']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start Time for Already timing' }));

    expect(
      await screen.findByRole('button', { name: 'Timer running on this task' }),
    ).toBeDisabled();
    expect(requests.some((request) => request.url.endsWith('/api/operator-timer/switch'))).toBe(
      false,
    );
  });

  it('disables unavailable task starts in both the card and global header', async () => {
    testState.tasksPayload = [task('t1', 'Unavailable task')];
    testState.projectsPayload = [{ ...projects[0], status: 'ARCHIVED' }];
    const { unmount } = render(
      <MemoryRouter initialEntries={['/status']}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('button', { name: 'Start Time for Unavailable task' }),
    ).toBeDisabled();
    unmount();

    testState.tasksPayload = [task('t1', 'Complete task', { status: 'COMPLETE' })];
    testState.projectsPayload = [projects[0]];
    render(
      <MemoryRouter initialEntries={['/countdown/t1']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'This task is complete.' })).toBeDisabled();
  });
});

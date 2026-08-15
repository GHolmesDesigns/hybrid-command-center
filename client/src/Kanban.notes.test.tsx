import {
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  task,
  testState,
} from './App.test-setup';

const renderBoard = async () => {
  render(
    <MemoryRouter initialEntries={['/status']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
};

describe('Task notes on the board', () => {
  it('shows notes when a task has no description', async () => {
    testState.tasksPayload = [task('t1', 'Call client', { notes: 'Ask about the launch date.' })];

    await renderBoard();

    const card = screen.getByRole('button', { name: /^Call client/ }).closest('.kanban-card')!;
    expect(card.querySelector('.card-description')).toBeNull();
    expect(card.querySelector('.card-notes')).toHaveTextContent('NotesAsk about the launch date.');
  });

  it('keeps notes visually separate from the description', async () => {
    testState.tasksPayload = [
      task('t1', 'Launch campaign', {
        description: 'Publish the client-approved campaign.',
        notes: 'Confirm the final tracking code first.',
      }),
    ];

    await renderBoard();

    const card = screen.getByRole('button', { name: /^Launch campaign/ }).closest('.kanban-card')!;
    expect(card.querySelector('.card-description')).toHaveTextContent(
      'Publish the client-approved campaign.',
    );
    expect(card.querySelector('.card-notes')).toHaveTextContent(
      'NotesConfirm the final tracking code first.',
    );
  });
});

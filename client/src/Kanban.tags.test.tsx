import {
  fireEvent,
  render,
  screen,
  within,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  type Tag,
  task,
  testState,
} from './App.test-setup';

describe('Board tag filtering and search', () => {
  const brand: Tag = { id: 'tag-brand', name: 'Brand system' };
  const urgent: Tag = { id: 'tag-urgent', name: 'Client review' };

  const renderBoard = async () => {
    testState.tagsPayload = [brand, urgent];
    testState.tasksPayload = [
      task('t1', 'Recap post', { tags: [brand] }),
      task('t2', 'Deck refresh', { tags: [brand, urgent] }),
      task('t3', 'Invoice chase', { tags: [] }),
    ];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
  };
  const cardTitles = () =>
    [...document.querySelectorAll('.kanban-card .card-title strong')].map((n) => n.textContent);
  /** The filter toggles are the only buttons named after a tag; cards render chips as text. */
  const tagFilter = (name: string) =>
    within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name });

  it('names every tag on the card it belongs to', async () => {
    await renderBoard();

    expect(screen.getByRole('list', { name: 'Tags on Deck refresh' })).toHaveTextContent(
      'Brand system',
    );
    expect(screen.getByRole('list', { name: 'Tags on Deck refresh' })).toHaveTextContent(
      'Client review',
    );
    expect(screen.queryByRole('list', { name: 'Tags on Invoice chase' })).toBeNull();
  });

  it('narrows the board to tasks carrying every selected tag', async () => {
    await renderBoard();

    fireEvent.click(tagFilter('Brand system'));
    expect(cardTitles()).toEqual(['Recap post', 'Deck refresh']);
    expect(tagFilter('Brand system')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(tagFilter('Client review'));
    expect(cardTitles()).toEqual(['Deck refresh']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear tags' }));
    expect(cardTitles()).toEqual(['Recap post', 'Deck refresh', 'Invoice chase']);
  });

  it('composes a tag filter with the existing priority filter', async () => {
    await renderBoard();

    fireEvent.click(tagFilter('Brand system'));
    expect(cardTitles()).toEqual(['Recap post', 'Deck refresh']);

    // Every seeded task is MEDIUM, so the two filters together can only be empty.
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), {
      target: { value: 'URGENT' },
    });
    expect(cardTitles()).toEqual([]);
  });

  it('matches tag names as well as titles from the board search', async () => {
    await renderBoard();
    const search = screen.getByRole('textbox', { name: 'Search' });

    fireEvent.change(search, { target: { value: 'client rev' } });
    expect(cardTitles()).toEqual(['Deck refresh']);

    fireEvent.change(search, { target: { value: 'invoice' } });
    expect(cardTitles()).toEqual(['Invoice chase']);

    fireEvent.change(search, { target: { value: 'nothing here' } });
    expect(cardTitles()).toEqual([]);
  });
});

import { useLocation } from 'react-router-dom';
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
  client,
  day,
  type Task,
  task,
  testState,
} from './App.test-setup';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>;
}

const renderBoard = async (tasks: Task[], entry = '/status') => {
  testState.tasksPayload = tasks;
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
      <LocationProbe />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
};

const cardTitles = () =>
  [...document.querySelectorAll('.kanban-card .card-title strong')].map((n) => n.textContent);
/** The count the page header claims, which has to agree with the board under every filter. */
const headerCount = () =>
  Number(/(\d+) visible tasks/.exec(document.querySelector('.page-head')!.textContent!)![1]);
const location = () => screen.getByLabelText('Current location').textContent;
const filterButton = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}:`) });
const filterOption = (name: string) => screen.getByRole('checkbox', { name });
const choose = (filter: string, option: string) => {
  fireEvent.click(filterButton(filter));
  fireEvent.click(filterOption(option));
};
/** Badges only: the filter bar now offers every type name as an option text as well. */
const typeBadges = () =>
  [...document.querySelectorAll('.task-type-badge')].map((n) => n.textContent);

describe('Task type on the board', () => {
  it('shows the type on the card and again in the task detail', async () => {
    await renderBoard([task('t1', 'Implement task types', { taskType: 'DEV_WORK' })]);

    expect(typeBadges()).toEqual(['Dev Work']);

    fireEvent.click(screen.getByRole('button', { name: /^Implement task types/ }));

    await waitFor(() => expect(typeBadges()).toEqual(['Dev Work', 'Dev Work']));
  });

  it('renders an untyped task with no badge at all', async () => {
    await renderBoard([task('t1', 'Legacy chore')]);

    expect(screen.getByRole('button', { name: /^Legacy chore/ })).toBeVisible();
    expect(document.querySelector('.task-type-badge')).toBeNull();
    // The priority badge beside it still renders, so the row itself is not missing.
    expect(document.querySelector('.priority-badge')).not.toBeNull();
  });
});

describe('Task type filtering on the board', () => {
  const seeded = () => [
    task('t1', 'Recap post', { taskType: 'BLOG_POST' }),
    task('t2', 'Launch graphics', { taskType: 'GRAPHICS', priority: 'URGENT' }),
    task('t3', 'Sponsor cutdown', { taskType: 'GRAPHICS' }),
    task('t4', 'Legacy chore'),
  ];

  it('narrows the board to one type and puts the choice in the URL', async () => {
    await renderBoard(seeded());
    expect(headerCount()).toBe(4);

    choose('Task type', 'Graphics');

    expect(cardTitles()).toEqual(['Launch graphics', 'Sponsor cutdown']);
    expect(headerCount()).toBe(2);
    expect(location()).toBe('/status?type=GRAPHICS');

    fireEvent.click(filterOption('Graphics'));

    expect(cardTitles()).toEqual([
      'Recap post',
      'Launch graphics',
      'Sponsor cutdown',
      'Legacy chore',
    ]);
    expect(location()).toBe('/status');
  });

  it('shows exactly the tasks with no type under "No type"', async () => {
    await renderBoard(seeded());

    choose('Task type', 'No type');

    expect(cardTitles()).toEqual(['Legacy chore']);
    expect(headerCount()).toBe(1);
    expect(location()).toBe('/status?type=none');
  });

  it('combines the type with priority rather than replacing it', async () => {
    await renderBoard(seeded());

    choose('Task type', 'Graphics');
    choose('Priority', 'URGENT');

    // Both filters are still applied: the second Graphics task is MEDIUM and drops out.
    expect(cardTitles()).toEqual(['Launch graphics']);
    expect(headerCount()).toBe(1);
    expect(filterOption('Graphics')).toBeChecked();
    expect(location()).toBe('/status?type=GRAPHICS&priority=URGENT');
  });

  it('reproduces the same board from a pasted URL, priority included', async () => {
    await renderBoard(seeded(), '/status?type=GRAPHICS&priority=URGENT');

    expect(cardTitles()).toEqual(['Launch graphics']);
    expect(headerCount()).toBe(1);
    expect(filterOption('Graphics')).toBeChecked();
    expect(filterOption('URGENT')).toBeChecked();
  });

  it('keeps the type beside the client, project, focus, tag, and search filters', async () => {
    const tag = { id: 'tag-brand', name: 'Brand system' };
    testState.tagsPayload = [tag];
    testState.clientsPayload = [client('client-p1', 'Acme')];
    await renderBoard(
      [
        task('t1', 'Launch graphics', { taskType: 'GRAPHICS', tags: [tag], dueDate: day(2) }),
        task('t2', 'Sponsor cutdown', { taskType: 'GRAPHICS', dueDate: day(2) }),
      ],
      '/status?project=p1&client=client-p1&filter=week&tags=tag-brand',
    );

    choose('Task type', 'Graphics');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'launch' },
    });

    expect(cardTitles()).toEqual(['Launch graphics']);
    expect(location()).toBe(
      '/status?project=p1&client=client-p1&filter=week&tags=tag-brand&type=GRAPHICS',
    );
  });
});

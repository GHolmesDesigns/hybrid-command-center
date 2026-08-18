import { useLocation } from 'react-router-dom';
import {
  fireEvent,
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  client,
  project,
  task,
  testState,
} from './App.test-setup';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>;
}

const renderBoard = async (entry = '/status') => {
  testState.clientsPayload = [client('c1', 'Acme'), client('c2', 'Bravo')];
  testState.projectsPayload = [
    project('p1', 'Acme launch', 'ACTIVE', { clientId: 'c1', clientName: 'Acme' }),
    project('p2', 'Bravo launch', 'ACTIVE', { clientId: 'c2', clientName: 'Bravo' }),
  ];
  testState.tasksPayload = [
    task('t1', 'Urgent graphics', {
      clientId: 'c1',
      clientName: 'Acme',
      projectId: 'p1',
      projectName: 'Acme launch',
      priority: 'URGENT',
      taskType: 'GRAPHICS',
    }),
    task('t2', 'High legacy task', {
      clientId: 'c2',
      clientName: 'Bravo',
      projectId: 'p2',
      projectName: 'Bravo launch',
      priority: 'HIGH',
    }),
    task('t3', 'Medium graphics', {
      clientId: 'c1',
      clientName: 'Acme',
      projectId: 'p1',
      projectName: 'Acme launch',
      priority: 'MEDIUM',
      taskType: 'GRAPHICS',
    }),
  ];
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
      <LocationProbe />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
};

const titles = () =>
  [...document.querySelectorAll('.kanban-card .card-title strong')].map((node) => node.textContent);
const location = () => screen.getByLabelText('Current location').textContent;
const toggle = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));

describe('Status board multi-select filters', () => {
  it('uses OR within each dimension and AND between dimensions from a deep link', async () => {
    await renderBoard('/status?priority=HIGH,URGENT&type=GRAPHICS,none');

    expect(titles()).toEqual(['Urgent graphics', 'High legacy task']);
    expect(screen.getByRole('checkbox', { name: 'URGENT' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'HIGH' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Graphics' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'No type' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Priority: 2 selected' })).toBeVisible();
  });

  it('serializes selections deterministically and keeps a bookmarked single value valid', async () => {
    await renderBoard('/status?priority=URGENT');

    expect(titles()).toEqual(['Urgent graphics']);
    toggle('HIGH');
    expect(location()).toBe('/status?priority=HIGH%2CURGENT');
    expect(titles()).toEqual(['Urgent graphics', 'High legacy task']);
  });

  it('drops projects whose client is removed while preserving valid projects', async () => {
    await renderBoard('/status?client=c1,c2&project=p1,p2');

    toggle('Acme');

    expect(location()).toBe('/status?client=c2&project=p2');
    expect(titles()).toEqual(['High legacy task']);
    expect(screen.getByRole('checkbox', { name: 'Bravo launch' })).toBeChecked();
  });

  it('clears every durable board filter together', async () => {
    testState.tagsPayload = [{ id: 'tag-1', name: 'Launch' }];
    await renderBoard('/status?priority=HIGH&type=none&tags=tag-1');

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(location()).toBe('/status');
    expect(titles()).toEqual(['Urgent graphics', 'High legacy task', 'Medium graphics']);
  });
});

import { useLocation } from 'react-router-dom';
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
  client,
  clickTopbarNewTask,
  project,
  requests,
  task,
  testState,
} from './App.test-setup';

const activeClient = client('client-p1', 'Acme Studio');
const archivedClient = client('client-old', 'Former Client', 'ARCHIVED');
const archivedClientProject = project('old-project', 'Legacy Campaign', 'ACTIVE', {
  clientId: archivedClient.id,
  clientName: archivedClient.name,
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>;
}

const renderApp = (entry = '/clients') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
      <LocationProbe />
    </MemoryRouter>,
  );

describe('Archived client visibility', () => {
  it('defaults to Active and keeps search inside the selected visibility', async () => {
    testState.clientsPayload = [activeClient, archivedClient];
    renderApp();

    expect(await screen.findByRole('heading', { name: activeClient.name })).toBeVisible();
    expect(screen.queryByRole('heading', { name: archivedClient.name })).toBeNull();
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: archivedClient.name },
    });
    expect(screen.queryByRole('heading', { name: archivedClient.name })).toBeNull();
    expect(screen.getByText('No active clients match this search.')).toBeVisible();
  });

  it('stores Archived and All views in the URL so they survive reload and sharing', async () => {
    testState.clientsPayload = [activeClient, archivedClient];
    renderApp();
    await screen.findByRole('heading', { name: activeClient.name });

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/clients?visibility=archived',
    );
    expect(screen.getByRole('heading', { name: archivedClient.name })).toBeVisible();
    expect(screen.queryByRole('heading', { name: activeClient.name })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/clients?visibility=all');
    expect(screen.getByRole('heading', { name: activeClient.name })).toBeVisible();
    expect(screen.getByRole('heading', { name: archivedClient.name })).toBeVisible();
  });

  it('keeps an archived client directly reachable and offers a reversible unarchive path', async () => {
    testState.clientsPayload = [archivedClient];
    testState.projectsPayload = [archivedClientProject];
    renderApp(`/clients/${archivedClient.id}`);

    expect(await screen.findByText('This client is archived')).toBeVisible();
    expect(screen.queryByRole('button', { name: /new project/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive client' }));

    await waitFor(() =>
      expect(requests).toContainEqual({
        url: `/api/clients/${archivedClient.id}/unarchive`,
        method: 'POST',
        body: undefined,
      }),
    );
    expect(await screen.findByRole('button', { name: /new project/i })).toBeVisible();
    expect(screen.queryByText('This client is archived')).toBeNull();
  });

  it('excludes archived clients projects from new-task and dependency selectors', async () => {
    const activeCandidate = task('active-candidate', 'Active dependency');
    const archivedCandidate = task('archived-candidate', 'Archived dependency', {
      projectId: archivedClientProject.id,
      projectName: archivedClientProject.name,
      clientId: archivedClient.id,
      clientName: archivedClient.name,
    });
    testState.clientsPayload = [activeClient, archivedClient];
    testState.projectsPayload = [project('p1', 'Site refresh'), archivedClientProject];
    testState.tasksPayload = [task('current', 'Current task'), activeCandidate, archivedCandidate];
    renderApp('/kanban');
    await screen.findByRole('heading', { name: 'Project Status' });

    clickTopbarNewTask();
    const projectPicker = within(screen.getByRole('dialog')).getByLabelText('Project');
    expect(within(projectPicker).getByRole('option', { name: /Site refresh/ })).toBeInTheDocument();
    expect(within(projectPicker).queryByRole('option', { name: /Legacy Campaign/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Close'));

    fireEvent.click(screen.getByRole('button', { name: /^Current task/ }));
    const dependencyPicker = within(screen.getByRole('dialog')).getByLabelText('Dependency task');
    expect(
      within(dependencyPicker).getByRole('option', { name: /Active dependency/ }),
    ).toBeVisible();
    expect(
      within(dependencyPicker).queryByRole('option', { name: /Archived dependency/ }),
    ).toBeNull();
  });
});

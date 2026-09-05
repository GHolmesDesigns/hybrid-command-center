import {
  fireEvent,
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  type Client,
  testState,
} from './App.test-setup';

describe('Project launch date form', () => {
  const acme: Client = {
    id: 'client-acme',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    driveStatus: 'DISCONNECTED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  };

  it('shows planned launch separately from the target deadline', async () => {
    testState.clientsPayload = [acme];
    testState.projectsPayload = [];
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /New project/ }));
    expect(await screen.findByRole('heading', { name: 'New project' })).toBeVisible();
    expect(screen.getByLabelText('Planned launch date')).toBeVisible();
    expect(screen.getByLabelText('Target deadline')).toBeVisible();
    expect(screen.getByLabelText('Start date')).toBeVisible();
  });
});

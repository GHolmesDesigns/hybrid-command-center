import {
  App,
  MemoryRouter,
  describe,
  expect,
  fireEvent,
  it,
  project,
  render,
  requests,
  screen,
  testState,
  vi,
  waitFor,
} from './App.test-setup';

describe('project deletion with Signal assignments', () => {
  for (const route of ['/projects', '/projects/p1']) {
    it(`warns and reports the detached count from ${route}`, async () => {
      testState.projectsPayload = [project('p1', 'Site refresh', 'ACTIVE', { signalPostCount: 2 })];
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(
        <MemoryRouter initialEntries={[route]}>
          <App />
        </MemoryRouter>,
      );

      const deleteButton = await screen.findByRole('button', {
        name: route === '/projects' ? 'Delete Site refresh' : 'Delete project',
      });
      expect(screen.getByText(/2 Signal posts will be unassigned, not deleted\./)).toBeVisible();
      fireEvent.click(deleteButton);
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining('2 Signal posts will be unassigned, not deleted.'),
      );
      await waitFor(() =>
        expect(
          requests.some(
            (request) => request.url.endsWith('/api/projects/p1') && request.method === 'DELETE',
          ),
        ).toBe(true),
      );
      expect(
        await screen.findByText(
          'Project deleted from Command Center. 2 Signal posts unassigned, not deleted. Drive files were left alone.',
        ),
      ).toBeVisible();
      expect(testState.projectsPayload).toEqual([]);
    });
  }
});

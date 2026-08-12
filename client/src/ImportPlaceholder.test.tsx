import {
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  branding,
} from './App.test-setup';

describe('Import module placeholder', () => {
  it('lists Import in the sidebar Coming next group without linking anywhere', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    expect(screen.getByText('Import')).toHaveClass('nav-disabled');
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  });

  it('hides Import when the sidebar is collapsed, like Calendar and Files', async () => {
    localStorage.setItem('hcc-sidebar-collapsed', '1');
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    expect(screen.queryByText('Import')).toBeNull();
    expect(screen.queryByText('Calendar')).toBeNull();
    expect(screen.queryByText('Files')).toBeNull();
  });

  it('lists an Import entry in the Settings future modules card', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(screen.getByText('Campaign playbook import')).toBeVisible();
  });
});

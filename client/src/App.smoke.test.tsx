import { useLocation } from 'react-router-dom';
import { act } from '@testing-library/react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  APP_VERSION,
  branding,
  task,
  testState,
  requests,
} from './App.test-setup';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>;
}

describe('App', () => {
  it.each(['/ads', '/signal', '/files', '/health', '/agents', '/settings'])(
    'applies the shared design-system scope to %s',
    async (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() =>
        expect(document.querySelector('.page-wrap')).toHaveClass('workspace-design-system'),
      );
    },
  );

  it('opens the Agent Hub WebSocket when live updates are enabled', async () => {
    testState.liveTipsPayload = { enabled: true };
    const opened: string[] = [];
    let onmessage: ((event: MessageEvent) => void) | null = null;
    class MockWebSocket {
      close() {}
      onerror: (() => void) | null = null;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        opened.push(url);
        queueMicrotask(() => this.onopen?.());
      }
      set onmessage(fn: ((event: MessageEvent) => void) | null) {
        onmessage = fn;
      }
      send() {}
    }
    const original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const notificationReads = () =>
      requests.filter((request) => request.url.includes('/api/agent-notifications'));

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(branding.title)).toBeInTheDocument();
    await waitFor(() => expect(opened.some((url) => url.includes('/api/agent-hub/ws'))).toBe(true));
    const initialReads = notificationReads().length;
    act(() => {
      onmessage?.({
        data: JSON.stringify({ kind: 'wake', seq: 1, feeds: ['notifications'] }),
      } as MessageEvent);
    });
    await waitFor(() => expect(notificationReads().length).toBeGreaterThan(initialReads));
    globalThis.WebSocket = original;
  });

  it('renders the sidebar with fetched branding once loading resolves', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(branding.title)).toBeInTheDocument();
    expect(screen.getByText(branding.subtitle)).toBeInTheDocument();
    expect(screen.getByText(`v${APP_VERSION}`)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Status' })).toHaveAttribute('href', '/status');
  });

  it('shows the specified primary navigation order with the disclosure on Settings', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' });
    const topLevelLinks = navigation.querySelectorAll(
      ':scope > a, :scope > .settings-nav-group > .settings-nav-top > a',
    );
    expect(Array.from(topLevelLinks, (link) => link.textContent?.trim())).toEqual([
      'Dashboard',
      'Clients',
      'Projects',
      'Status',
      'Countdown',
      'Ads',
      'Signal',
      'Calendar',
      'Time',
      'Settings',
    ]);
    expect(screen.getByRole('button', { name: 'Expand Settings pages' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('Pages')).toBeNull();
  });

  it('expands Settings pages in order and collapses them with an accessible disclosure', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    const disclosure = await screen.findByRole('button', { name: 'Expand Settings pages' });
    disclosure.focus();
    expect(document.activeElement).toBe(disclosure);
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/');
    const children = screen
      .getByRole('navigation', { name: 'Primary navigation' })
      .querySelector('.settings-nav-children');
    expect(
      Array.from(children?.querySelectorAll('a') ?? [], (link) => link.textContent?.trim()),
    ).toEqual(['Agents', 'Files', 'Health', 'Import']);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Settings pages' }));
    expect(screen.queryByRole('link', { name: 'Files' })).toBeNull();
  });

  it('navigates to Settings without toggling its disclosure', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('link', { name: 'Settings' }));
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/settings');
    expect(screen.getByRole('button', { name: 'Expand Settings pages' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens Settings automatically for a direct child route and marks that child active', async () => {
    render(
      <MemoryRouter initialEntries={['/health']}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Application health' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Collapse Settings pages' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Health' })).toHaveAttribute('aria-current', 'page');
  });

  it('labels the board route Status without exposing the word Kanban', async () => {
    render(
      <MemoryRouter initialEntries={['/status']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(screen.queryByText(/kanban/i)).toBeNull();
  });

  it('renders Countdown and links the Pomodoro timer to project tasks', async () => {
    testState.tasksPayload = [
      task('focus-task', 'Draft the homepage', { projectName: 'Website Refresh' }),
    ];
    render(
      <MemoryRouter initialEntries={['/countdown']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Countdown' })).toBeVisible();
    expect(screen.getByText('Draft the homepage')).toBeVisible();
    expect(screen.getByText('Website Refresh')).toBeVisible();
    const links = within(
      await screen.findByRole('navigation', { name: 'Primary navigation' }),
    ).getAllByRole('link');
    expect(links.find((link) => link.textContent?.trim() === 'Countdown')).toHaveAttribute(
      'href',
      '/countdown',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Start/ })).toBeEnabled());
  });

  it('redirects /tasks to /countdown and preserves the query string', async () => {
    render(
      <MemoryRouter initialEntries={['/tasks?task=focus-task']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Countdown' })).toBeVisible();
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/countdown?task=focus-task',
    );
  });

  it('redirects /kanban to /status and keeps the query string', async () => {
    render(
      <MemoryRouter initialEntries={['/kanban?filter=today']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/status?filter=today');
    expect(screen.getByRole('checkbox', { name: 'Due today' })).toBeChecked();
  });
});

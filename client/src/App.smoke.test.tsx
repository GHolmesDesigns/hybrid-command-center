import { useLocation } from 'react-router-dom';
import { act } from '@testing-library/react';
import {
  render,
  screen,
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
  it('opens the Agent Hub tip stream when live tips are enabled', async () => {
    testState.liveTipsPayload = { enabled: true };
    const opened: string[] = [];
    let onmessage: ((event: MessageEvent) => void) | null = null;
    class MockEventSource {
      close() {}
      onerror = null;
      constructor(url: string) {
        opened.push(url);
      }
      set onmessage(fn: ((event: MessageEvent) => void) | null) {
        onmessage = fn;
      }
    }
    const original = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const notificationReads = () =>
      requests.filter((request) => request.url.includes('/api/agent-notifications'));

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(branding.title)).toBeInTheDocument();
    await waitFor(() => expect(opened).toContain('/api/agent-hub/tips'));
    const initialReads = notificationReads().length;
    act(() => {
      onmessage?.({ data: JSON.stringify({ feeds: ['notifications'] }) } as MessageEvent);
    });
    await waitFor(() => expect(notificationReads().length).toBeGreaterThan(initialReads));
    globalThis.EventSource = original;
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

  it('keeps Agents immediately before Settings in primary navigation', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' });
    const links = within(navigation).getAllByRole('link');
    const labels = links.map((link) => link.textContent?.trim());
    const agentsIndex = labels.indexOf('Agents');
    expect(agentsIndex).toBeGreaterThanOrEqual(0);
    expect(labels[agentsIndex + 1]).toBe('Settings');
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

  it('places Tasks below Status and links the Pomodoro timer to project tasks', async () => {
    testState.tasksPayload = [
      task('focus-task', 'Draft the homepage', { projectName: 'Website Refresh' }),
    ];
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    expect(screen.getByText('Draft the homepage')).toBeVisible();
    expect(screen.getByText('Website Refresh')).toBeVisible();
    const links = within(
      await screen.findByRole('navigation', { name: 'Primary navigation' }),
    ).getAllByRole('link');
    expect(links.findIndex((link) => link.textContent?.trim() === 'Tasks')).toBe(
      links.findIndex((link) => link.textContent?.trim() === 'Status') + 1,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Start/ })).toBeEnabled());
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

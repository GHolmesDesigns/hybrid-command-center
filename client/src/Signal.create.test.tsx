import {
  App,
  afterEach,
  beforeEach,
  branding,
  describe,
  expect,
  fireEvent,
  it,
  render,
  requests,
  screen,
  signalPost,
  testState,
  waitFor,
  within,
  vi,
} from './App.test-setup';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

const openSignal = async (entry = '/signal?month=2026-09') => {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: [entry],
  });
  render(<RouterProvider router={router} />);
  await screen.findByText(branding.title);
  await screen.findByRole('heading', { level: 1, name: 'Content planner' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  return router;
};

describe('Signal Add Post entry points', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 23, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the shared form from a day cell with that local date prefilled', async () => {
    testState.signalPostsPayload = [];
    const router = await openSignal('/signal?month=2026-09');

    fireEvent.click(screen.getByRole('button', { name: 'Add post on 2026-09-14' }));

    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByRole('heading', { name: 'Add post' })).toBeInTheDocument();
    expect(within(editor).getByLabelText('Date')).toHaveValue('2026-09-14');
    expect(router.state.location.search).toContain('new=2026-09-14');
    expect(router.state.location.search).toContain('month=2026-09');
  });

  it('opens the correct adjacent-month date without moving the selected month', async () => {
    testState.signalPostsPayload = [];
    const router = await openSignal('/signal?month=2026-09');

    fireEvent.click(screen.getByRole('button', { name: 'Add post on 2026-10-03' }));

    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByLabelText('Date')).toHaveValue('2026-10-03');
    expect(router.state.location.search).toContain('new=2026-10-03');
    expect(router.state.location.search).toContain('month=2026-09');
  });

  it('opens an unscheduled draft from the queue Add post action', async () => {
    testState.signalPostsPayload = [];
    const router = await openSignal('/signal?month=2026-09');

    const [, queueAdd] = screen.getAllByRole('button', { name: 'Add post' });
    fireEvent.click(queueAdd!);

    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByRole('heading', { name: 'Add post' })).toBeInTheDocument();
    expect(within(editor).getByLabelText('Date')).toHaveValue('');
    expect(router.state.location.search).toContain('new=1');
  });

  it('opens an unscheduled draft from the top navigation and preserves the month', async () => {
    testState.signalPostsPayload = [];
    const router = await openSignal('/signal?month=2026-09');

    fireEvent.click(screen.getAllByRole('button', { name: 'Add post' })[0]!);

    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByLabelText('Date')).toHaveValue('');
    expect(router.state.location.search).toContain('month=2026-09');
    expect(router.state.location.search).toContain('new=1');
  });

  it('creates through the same POST path and clears creation state on save', async () => {
    testState.signalPostsPayload = [];
    const router = await openSignal('/signal?month=2026-09&new=2026-09-15');

    const editor = await screen.findByRole('dialog');
    fireEvent.change(within(editor).getByLabelText('Content'), {
      target: { value: 'Day-cell draft for September 15' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'Add post' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/signal/posts') &&
          (request.body as { text?: string; date?: string }).text ===
            'Day-cell draft for September 15' &&
          (request.body as { date?: string }).date === '2026-09-15',
      ),
    ).toBe(true);
    expect(router.state.location.search).not.toContain('new=');
    expect(router.state.location.search).toContain('month=2026-09');
    expect(await screen.findByText('Day-cell draft for September 15')).toBeInTheDocument();
  });

  it('clears creation state on close without writing a post', async () => {
    testState.signalPostsPayload = [signalPost('keep', 'Already there', '2026-09-10')];
    const router = await openSignal('/signal?month=2026-09&new=1');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.search).not.toContain('new=');
    expect(router.state.location.search).toContain('month=2026-09');
    expect(
      requests.some(
        (request) => request.method === 'POST' && request.url.endsWith('/api/signal/posts'),
      ),
    ).toBe(false);
  });

  it('ignores an invalid new value', async () => {
    testState.signalPostsPayload = [signalPost('named', 'A named campaign post', '2026-09-14')];
    await openSignal('/signal?month=2026-09&new=not-a-date');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lets a named post win over new in the address', async () => {
    testState.signalPostsPayload = [signalPost('named', 'A named campaign post', '2026-09-14')];
    await openSignal('/signal?month=2026-09&new=1&post=named');
    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByRole('heading', { name: 'Edit post' })).toBeInTheDocument();
    expect(within(editor).getByLabelText('Content')).toHaveValue('A named campaign post');
  });
});

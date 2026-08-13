import {
  App,
  MemoryRouter,
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
} from './App.test-setup';

const openSignal = async () => {
  render(
    <MemoryRouter initialEntries={['/signal?month=2026-09']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  return screen.findByRole('heading', { level: 1, name: 'Content planner' });
};

describe('Signal planner', () => {
  it('keeps undated ideas in the queue and dated posts in their month cells', async () => {
    testState.signalPostsPayload = [
      signalPost('queued', 'An idea without a date', null, { status: 'DRAFT' }),
      signalPost('scheduled', 'The September launch post', '2026-09-14', {
        channels: ['li', 'ig'],
      }),
      signalPost('october', 'Not in this month', '2026-10-01'),
    ];
    await openSignal();

    const queue = screen.getByRole('complementary', { name: 'Unscheduled queue' });
    expect(within(queue).getByText('An idea without a date')).toBeInTheDocument();
    expect(within(queue).queryByText('The September launch post')).not.toBeInTheDocument();

    const day = screen.getByRole('region', { name: '2026-09-14' });
    expect(within(day).getByText('The September launch post')).toBeInTheDocument();
    expect(within(day).getByText('LinkedIn')).toHaveClass('sr-only');
    expect(within(day).getByText('Instagram')).toHaveClass('sr-only');
    expect(screen.queryByText('Not in this month')).not.toBeInTheDocument();
  });

  it('validates editor content before sending a patch', async () => {
    testState.signalPostsPayload = [
      signalPost('queued', 'Edit this idea', null, { status: 'DRAFT' }),
    ];
    await openSignal();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Edit this idea' }));

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save post' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A post needs content.');
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
  });

  it('moves a saved post between queue and grid and reloads both API views', async () => {
    testState.signalPostsPayload = [
      signalPost('queued', 'Schedule this', null, { status: 'DRAFT' }),
    ];
    await openSignal();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Schedule this' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'SCHEDULED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save post' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      within(screen.getByRole('region', { name: '2026-09-20' })).getByText('Schedule this'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('complementary', { name: 'Unscheduled queue' })).queryByText(
        'Schedule this',
      ),
    ).not.toBeInTheDocument();
    expect(
      requests.filter((request) => request.url.includes('/api/signal/queue')).length,
    ).toBeGreaterThan(1);
    expect(
      requests.filter((request) => request.url.includes('/api/signal/posts?')).length,
    ).toBeGreaterThan(1);
  });

  it('renders very long copy without replacing or clipping its text node', async () => {
    const long = `A thousand-character post ${'with durable copy '.repeat(70)}`;
    testState.signalPostsPayload = [signalPost('long', long, '2026-09-09')];
    await openSignal();
    expect(
      screen.getByText((content) => content.startsWith('A thousand-character post')),
    ).toHaveClass('signal-post-text');
  });
});

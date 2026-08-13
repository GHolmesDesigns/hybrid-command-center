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

/** The size of copy the campaign posts actually run to, ending in a line only a full view shows. */
const LONG = `A thousand-character post ${'with durable copy '.repeat(70)}and a closing line.`;

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

  it('previews a long post in its cell and opens the rest in place', async () => {
    testState.signalPostsPayload = [signalPost('long', LONG, '2026-09-09')];
    await openSignal();
    const day = screen.getByRole('region', { name: '2026-09-09' });

    // Truncated, and it says so with an ellipsis rather than simply stopping.
    const body = within(day).getByText((content) => content.startsWith('A thousand-character'));
    expect(body).toHaveClass('signal-post-text');
    expect(body.textContent).toMatch(/…$/);
    expect(body.textContent!.length).toBeLessThan(LONG.length);
    expect(within(day).queryByText(/and a closing line\.$/)).not.toBeInTheDocument();

    // Expanding shows the whole post, and collapsing puts the preview back.
    const expand = within(day).getByRole('button', { name: /^Show more of A thousand-character/ });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);

    const opened = within(day).getByText(LONG);
    expect(opened).toHaveClass('signal-post-text');
    const collapse = within(day).getByRole('button', {
      name: /^Show less of A thousand-character/,
    });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(collapse).toHaveAttribute('aria-controls', opened.id);

    fireEvent.click(collapse);
    expect(within(day).queryByText(LONG)).not.toBeInTheDocument();
    expect(within(day).getByRole('button', { name: /^Show more of/ })).toBeInTheDocument();
  });

  it('keeps expanding and editing apart, and leaves a short post with nothing to expand', async () => {
    testState.signalPostsPayload = [
      signalPost('long', LONG, '2026-09-09'),
      signalPost('short', 'A post that fits', '2026-09-10'),
      signalPost('queued', LONG, null, { status: 'DRAFT' }),
    ];
    await openSignal();
    const day = screen.getByRole('region', { name: '2026-09-09' });

    // Expanding is a sibling of editing, not a click that falls through to it.
    fireEvent.click(within(day).getByRole('button', { name: /^Show more of/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // …and editing still opens the editor from the post itself, on the whole text.
    fireEvent.click(
      within(day).getByRole('button', { name: (name) => name.startsWith('Edit A thousand') }),
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Content')).toHaveValue(LONG);

    // A post short enough to show in full offers no control that would do nothing.
    const short = screen.getByRole('region', { name: '2026-09-10' });
    expect(
      within(short).getByRole('button', { name: 'Edit A post that fits' }),
    ).toBeInTheDocument();
    expect(within(short).queryByRole('button', { name: /^Show more/ })).not.toBeInTheDocument();

    // The queue is a column of its own with no neighbour to stretch, so it is left whole.
    const queue = screen.getByRole('complementary', { name: 'Unscheduled queue' });
    expect(within(queue).getByText(LONG)).toHaveClass('signal-post-text');
    expect(within(queue).queryByRole('button', { name: /^Show more/ })).not.toBeInTheDocument();
  });
});

import {
  App,
  MemoryRouter,
  afterEach,
  beforeEach,
  branding,
  describe,
  expect,
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

/**
 * Delivery status on planner cards — planning and delivery named separately, from one batch read.
 */

const openSignal = async () => {
  render(
    <MemoryRouter initialEntries={['/signal?month=2026-09']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
};

describe('Signal planner card delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 23, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows planning and delivery as two named indicators from one batch read', async () => {
    const post = signalPost('card-delivery', 'A card with delivery', '2026-09-14', {
      channels: ['x'],
      status: 'SCHEDULED',
    });
    testState.signalPostsPayload = [post];
    testState.cardDeliveryPayload = [
      { postId: post.id, state: 'PARTIAL', label: 'Partly delivered' },
    ];
    await openSignal();

    const card = screen.getByRole('button', { name: 'Edit A card with delivery' });
    expect(card).toHaveTextContent('Scheduled');
    expect(card).toHaveTextContent('Partly delivered');
    expect(within(card).getByText('Planning:')).toBeInTheDocument();
    expect(within(card).getByText('Delivery:')).toBeInTheDocument();

    const batchReads = requests.filter(
      (entry) => entry.url.includes('/api/signal/card-delivery?') && entry.method === 'GET',
    );
    expect(batchReads).toHaveLength(1);
    expect(batchReads[0]?.url).toContain('from=2026-08-30');
    expect(batchReads[0]?.url).toContain('to=2026-10-03');
    // Opening the planner never fans out into one publications request per card.
    expect(
      requests.filter((entry) => entry.url.includes('/publications') && entry.method === 'GET'),
    ).toHaveLength(0);
  });

  it('keeps not-submitted, in-flight, failed, ambiguous, and manual finish visible on cards', async () => {
    const posts = [
      signalPost('none', 'Not sent yet', '2026-09-14', { status: 'SCHEDULED' }),
      signalPost('flight', 'Still in flight', '2026-09-15', { status: 'SCHEDULED' }),
      signalPost('failed', 'Failed out', '2026-09-16', { status: 'SCHEDULED' }),
      signalPost('ambiguous', 'Never confirmed', '2026-09-17', { status: 'SCHEDULED' }),
      signalPost('manual', 'Needs a hand finish', '2026-09-18', { status: 'SCHEDULED' }),
    ];
    testState.signalPostsPayload = posts;
    testState.cardDeliveryPayload = [
      { postId: 'none', state: 'NONE', label: 'Not submitted' },
      { postId: 'flight', state: 'IN_FLIGHT', label: 'In progress' },
      { postId: 'failed', state: 'FAILED', label: 'Not delivered' },
      { postId: 'ambiguous', state: 'AMBIGUOUS', label: 'Unconfirmed' },
      { postId: 'manual', state: 'MANUAL', label: 'Finish by hand' },
    ];
    await openSignal();

    expect(screen.getByRole('button', { name: 'Edit Not sent yet' })).toHaveTextContent(
      'Not submitted',
    );
    expect(screen.getByRole('button', { name: 'Edit Still in flight' })).toHaveTextContent(
      'In progress',
    );
    expect(screen.getByRole('button', { name: 'Edit Failed out' })).toHaveTextContent(
      'Not delivered',
    );
    expect(screen.getByRole('button', { name: 'Edit Never confirmed' })).toHaveTextContent(
      'Unconfirmed',
    );
    expect(screen.getByRole('button', { name: 'Edit Needs a hand finish' })).toHaveTextContent(
      'Finish by hand',
    );
  });
});

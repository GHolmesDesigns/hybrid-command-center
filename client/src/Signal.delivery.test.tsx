import {
  App,
  MemoryRouter,
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
import type { SignalPublication } from '../../shared/publish';

const openSignal = async () => {
  render(
    <MemoryRouter initialEntries={['/signal?month=2026-09']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
};

const publication = (overrides: Partial<SignalPublication> = {}): SignalPublication => ({
  id: 'publication-1',
  postId: 'delivery',
  state: 'SUBMITTED',
  provider: 'post-bridge',
  providerPostId: 'provider-1',
  scheduledInstant: '2026-09-20T13:00:00.000Z',
  timezone: 'America/New_York',
  sentCaption: 'A delivered campaign post',
  sentChannels: ['x'],
  targets: [],
  checkAttempts: 0,
  createdAt: '2026-09-14T09:00:00.000Z',
  updatedAt: '2026-09-14T09:00:00.000Z',
  ...overrides,
});

/**
 * Delivery, read beside the planning status rather than instead of it.
 *
 * These cases are the ones a single status word could not have carried: two accounts on one
 * submission disagreeing, a delivery the provider accepted that a person still has to finish, and
 * a channel that was never sent anywhere at all.
 */
describe('Signal delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 23, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps planning status and delivery as two separate things on the page', async () => {
    const post = signalPost('delivery', 'A delivered campaign post', '2026-09-14', {
      channels: ['x'],
      status: 'SCHEDULED',
    });
    testState.signalPostsPayload = [post];
    testState.publicationsPayload = [
      publication({
        checkedAt: '2026-09-14T10:00:00.000Z',
        checkAttempts: 1,
        targets: [
          {
            channel: 'x',
            platform: 'twitter',
            accountId: 4,
            handle: '@gholmes',
            mode: 'AUTOMATIC',
          },
        ],
      }),
    ];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit A delivered campaign post' }));

    // The plan is still the user's own field, under its own name.
    expect(screen.getByLabelText('Planning status')).toHaveValue('SCHEDULED');
    const delivery = await screen.findByRole('region', { name: 'Delivery' });
    // The state is grouped and said, never a raw stored word.
    expect(delivery).toHaveTextContent('Accepted, not out yet');
    expect(delivery).not.toHaveTextContent('SUBMITTED');
    expect(delivery).toHaveTextContent('Automatic publishing');
    expect(delivery).toHaveTextContent('Last checked');
    expect(delivery).toHaveTextContent('Next automatic check');
  });

  it('shows each account of a partial submission with its own answer', async () => {
    const post = signalPost('delivery', 'A split campaign post', '2026-09-14', {
      channels: ['x', 'fb'],
      status: 'SCHEDULED',
    });
    testState.signalPostsPayload = [post];
    testState.publicationsPayload = [
      publication({
        state: 'PARTIAL',
        sentChannels: ['x', 'fb'],
        targets: [
          {
            channel: 'x',
            platform: 'twitter',
            accountId: 4,
            handle: '@gholmes',
            mode: 'AUTOMATIC',
            outcome: 'SUCCESS',
            permalink: 'https://x.example/1',
          },
          {
            channel: 'fb',
            platform: 'facebook',
            accountId: 2,
            handle: 'gholmesdesigns',
            mode: 'AUTOMATIC',
            outcome: 'FAILURE',
            error: 'The page token was rejected.',
          },
        ],
      }),
    ];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit A split campaign post' }));

    const rows = within(await screen.findByRole('region', { name: 'Delivery' })).getAllByRole(
      'listitem',
    );
    expect(rows[0]).toHaveTextContent('@gholmes');
    expect(rows[0]).toHaveTextContent('Delivered');
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'Open the X post' }),
    ).toHaveAttribute('href', 'https://x.example/1');
    expect(rows[1]).toHaveTextContent('gholmesdesigns');
    expect(rows[1]).toHaveTextContent('Not delivered');
    expect(rows[1]).toHaveTextContent('The page token was rejected.');
  });

  it('explains a manual finish and lets a person record it without touching the post', async () => {
    const post = signalPost('delivery', 'A hand-finished campaign post', '2026-09-14', {
      channels: ['tt'],
      status: 'SCHEDULED',
    });
    const waiting = publication({
      sentChannels: ['tt'],
      targets: [
        {
          channel: 'tt',
          platform: 'tiktok',
          accountId: 8,
          handle: '@gholmes',
          mode: 'MANUAL_FINISH',
          outcome: 'SUCCESS',
        },
      ],
    });
    testState.signalPostsPayload = [post];
    testState.publicationsPayload = [waiting];
    testState.publishFinishPayload = {
      ...waiting,
      targets: [{ ...waiting.targets[0]!, manualCompletedAt: '2026-09-14T12:00:00.000Z' }],
    };
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit A hand-finished campaign post' }));

    const delivery = await screen.findByRole('region', { name: 'Delivery' });
    expect(delivery).toHaveTextContent('Manual finish required');
    expect(delivery).toHaveTextContent('Waiting for you to finish');
    // The instruction names the application and what is waiting in it, not just the mode.
    expect(delivery).toHaveTextContent('Open TikTok on that account');

    fireEvent.click(screen.getByRole('button', { name: 'Mark TikTok finished' }));
    await waitFor(() => expect(delivery).toHaveTextContent('Finished by hand'));
    expect(
      requests.some((entry) => entry.url.endsWith('/targets/8/finish') && entry.method === 'POST'),
    ).toBe(true);
    // Finishing a delivery is not a claim about the post, so nothing patched the planning status.
    expect(requests.filter((entry) => entry.method === 'PATCH')).toHaveLength(0);
    expect(screen.getByLabelText('Planning status')).toHaveValue('SCHEDULED');
  });

  it('names a channel no provider reaches and points at the status it belongs to', async () => {
    testState.signalPostsPayload = [
      signalPost('delivery', 'A blog-only campaign post', '2026-09-14', {
        channels: ['blog'],
        status: 'SCHEDULED',
      }),
    ];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit A blog-only campaign post' }));

    const delivery = await screen.findByRole('region', { name: 'Delivery' });
    expect(delivery).toHaveTextContent('Unsupported');
    expect(delivery).toHaveTextContent('No provider reaches Blog');
    // Its completion is the planning status, so that is the only control it offers.
    expect(within(delivery).getByRole('button', { name: 'Mark published' })).toBeInTheDocument();
    expect(
      within(delivery).queryByRole('button', { name: /Mark Blog finished/ }),
    ).not.toBeInTheDocument();
  });
});

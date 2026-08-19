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
  queueHealthAlert,
  waitFor,
  within,
} from './App.test-setup';

/**
 * The Signal health summary, as a reader meets it.
 *
 * The rules are not exercised here — they are derived on the server and tested against fixtures in
 * `shared/queue-health.test.ts`. What is checked here is the three things the page owes the rules: an
 * alert that says its level in words as well as in colour, a link that opens the post it is about,
 * and an acknowledgement that visibly changes nothing but the alert.
 */

/**
 * The planner, waited on until the summary has actually arrived.
 *
 * **Alert windows** is the wait rather than the refresh control: the panel's own Refresh is enabled
 * from the first render, so waiting on it proves only that the component mounted. The windows control
 * appears when a summary has been read, which is the state every case below is about. `health: false`
 * is for the one case where no summary arrives at all.
 */
const openSignal = async (path = '/signal?month=2026-09', { health = true } = {}) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  if (health) await screen.findByRole('button', { name: 'Alert windows' });
};

const panel = () => screen.getByRole('region', { name: 'What needs attention' });

describe('Signal queue health', () => {
  it('says nothing needs attention when nothing does', async () => {
    await openSignal();
    expect(within(panel()).getByText('Nothing needs attention.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: /Acknowledge/ })).toBeNull();
  });

  it('states each level in words beside its icon, never in colour alone', async () => {
    testState.queueHealthSummary = {
      ...testState.queueHealthSummary,
      alerts: [
        queueHealthAlert({
          id: 'DELIVERY_ATTENTION:publication-1',
          kind: 'DELIVERY_ATTENTION',
          severity: 'ACTION',
          title: 'Not delivered',
        }),
        queueHealthAlert({
          id: 'CHANNEL_UNCOVERED:ig',
          kind: 'CHANNEL_UNCOVERED',
          severity: 'WATCH',
          subject: 'Instagram',
          title: 'Nothing planned for the next 14 days',
        }),
      ],
      counts: { action: 1, watch: 1, acknowledged: 0 },
    };
    await openSignal();

    expect(within(panel()).getByText('1 needs action, 1 worth watching.')).toBeInTheDocument();
    expect(within(panel()).getByText('Needs action')).toBeInTheDocument();
    expect(within(panel()).getByText('Worth watching')).toBeInTheDocument();
    expect(within(panel()).getByText('Delivery')).toBeInTheDocument();
    expect(within(panel()).getByText('Channel coverage')).toBeInTheDocument();
  });

  it('opens the post an alert is about, from a link that survives being shared', async () => {
    testState.signalPostsPayload = [
      signalPost('delivery', 'A delivered campaign post', '2026-09-14', { channels: ['x'] }),
    ];
    testState.queueHealthSummary = {
      ...testState.queueHealthSummary,
      alerts: [
        queueHealthAlert({
          id: 'DELIVERY_ATTENTION:publication-1',
          kind: 'DELIVERY_ATTENTION',
          postId: 'delivery',
          href: '/signal?post=delivery',
        }),
      ],
      counts: { action: 1, watch: 0, acknowledged: 0 },
    };
    await openSignal();

    fireEvent.click(within(panel()).getByRole('link', { name: 'A delivered campaign post' }));
    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByLabelText('Content')).toHaveValue('A delivered campaign post');
  });

  it('opens a post the planner is not currently showing, by asking for it', async () => {
    testState.signalPostsPayload = [
      signalPost('elsewhere', 'A post from another month', '2027-02-10', { channels: ['x'] }),
    ];
    await openSignal('/signal?month=2026-09&post=elsewhere');
    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByLabelText('Content')).toHaveValue('A post from another month');
    expect(requests.some((entry) => entry.url.endsWith('/api/signal/posts/elsewhere'))).toBe(true);
  });

  it('says so when the post an alert names is no longer there', async () => {
    await openSignal('/signal?month=2026-09&post=deleted');
    expect(await screen.findByText('Signal post not found.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('acknowledges an alert without changing the post or its delivery', async () => {
    testState.signalPostsPayload = [
      signalPost('delivery', 'A delivered campaign post', '2026-09-14', { channels: ['x'] }),
    ];
    testState.queueHealthSummary = {
      ...testState.queueHealthSummary,
      alerts: [
        queueHealthAlert({ id: 'DELIVERY_ATTENTION:publication-1', kind: 'DELIVERY_ATTENTION' }),
      ],
      counts: { action: 1, watch: 0, acknowledged: 0 },
    };
    await openSignal();

    fireEvent.click(within(panel()).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(
        within(panel()).getByText('Nothing needs attention. 1 acknowledged.'),
      ).toBeInTheDocument(),
    );

    // One write, to the acknowledgement route, and nothing to a post or a publication.
    const writes = requests.filter((entry) => entry.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toBe(
      '/api/signal/health/alerts/DELIVERY_ATTENTION%3Apublication-1/acknowledge',
    );
    expect(writes[0]?.method).toBe('POST');
  });

  it('puts an acknowledged alert back on the list', async () => {
    testState.queueHealthSummary = {
      ...testState.queueHealthSummary,
      alerts: [
        queueHealthAlert({
          id: 'CHANNEL_UNCOVERED:ig',
          kind: 'CHANNEL_UNCOVERED',
          severity: 'WATCH',
          subject: 'Instagram',
          acknowledged: true,
          acknowledgedAt: '2026-09-14T12:30:00.000Z',
        }),
      ],
      counts: { action: 0, watch: 0, acknowledged: 1 },
    };
    await openSignal();

    fireEvent.click(within(panel()).getByRole('button', { name: '1 acknowledged' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Put back on the list' }));
    await waitFor(() => expect(within(panel()).getByText('1 worth watching.')).toBeInTheDocument());
    expect(requests.filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
  });

  it('saves the windows the alerts are measured against', async () => {
    await openSignal();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Alert windows' }));
    fireEvent.change(within(panel()).getByLabelText('Expect content this many days ahead'), {
      target: { value: '5' },
    });
    fireEvent.click(within(panel()).getByLabelText('Instagram'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Save windows' }));

    await waitFor(() =>
      expect(requests.some((entry) => entry.url.endsWith('/api/signal/health/config'))).toBe(true),
    );
    const saved = requests.find((entry) => entry.url.endsWith('/api/signal/health/config'));
    expect(saved?.method).toBe('PUT');
    expect(saved?.body).toMatchObject({ coverageDays: 5, coverageChannels: ['ig'] });
  });

  it('reports a summary it could not read and leaves the planner usable', async () => {
    testState.queueHealthError = 'Queue health is unavailable.';
    await openSignal('/signal?month=2026-09', { health: false });
    expect(await screen.findByText('Queue health is unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unscheduled queue' })).toBeInTheDocument();
  });
});

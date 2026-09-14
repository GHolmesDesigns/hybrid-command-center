import {
  App,
  MemoryRouter,
  beforeEach,
  branding,
  client,
  describe,
  expect,
  fireEvent,
  it,
  project,
  render,
  requests,
  screen,
  signalPost,
  testState,
  waitFor,
  within,
} from './App.test-setup';
import {
  SIGNAL_CAMPAIGN_NONE,
  SIGNAL_CAMPAIGN_NONE_LABEL,
} from '../../shared/signal-campaign-analytics';
import { SIGNAL_CLIENT_UNBOUND, SIGNAL_CLIENT_UNBOUND_LABEL } from '../../shared/signal';

/**
 * C186: the planner's own client/project/campaign filters and copy search — durable URL state for
 * the first three, transient for search, applied identically to the range, the queue, and the
 * delivery snapshot per `docs/view-state-convention.md`.
 *
 * The mock server in `App.test-setup` answers `from`/`to`/`lifecycle` only; it does not reproduce
 * the SQL scope `server/signal/filters.test.ts` already proves. What this file covers is the
 * browser's own half: that a chosen filter reaches the address and every one of the three requests,
 * that it survives navigation, and that clearing it removes exactly what it added.
 */

const acme = client('client-acme', 'Acme');
const brightline = client('client-brightline', 'Brightline');
const acmeProject = project('project-acme', 'Acme rollout');
const clarity = { id: 'campaign-1', name: 'Clarity Campaign' };

const openPlanner = async (entry = '/signal?month=2026-09') => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
};

const filters = () => screen.getByRole('region', { name: 'Filter the planner' });
const lastRequestTo = (segment: string) =>
  [...requests].reverse().find((request) => request.url.includes(segment));
const filterSummary = (label: string) =>
  within(filters()).getByRole('button', { name: new RegExp(`^${label}:`) });
const selectFilterOption = (label: string, option: string) => {
  const summary = filterSummary(label);
  const details = summary.closest('details');
  if (!details?.open) fireEvent.click(summary);
  fireEvent.click(within(details!).getByRole('checkbox', { name: option }));
};

describe('the planner filter bar', () => {
  beforeEach(() => {
    testState.clientsPayload = [acme, brightline];
    testState.projectsPayload = [acmeProject];
    testState.signalCampaignsPayload = [{ ...clarity, postCount: 0 }];
    testState.signalPostsPayload = [signalPost('p1', 'A scheduled post', '2026-09-14')];
  });

  it('puts a client filter in the address and sends it to posts, queue, and card-delivery, with several read as or', async () => {
    await openPlanner();

    selectFilterOption('Client', 'Acme');
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`client=${acme.id}`),
    );
    expect(lastRequestTo('/api/signal/queue')?.url).toContain(`client=${acme.id}`);
    expect(lastRequestTo('/api/signal/card-delivery')?.url).toContain(`client=${acme.id}`);
    expect(filterSummary('Client')).toHaveAccessibleName('Client: Acme');

    selectFilterOption('Client', 'Brightline');
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(
        `client=${encodeURIComponent(`${acme.id},${brightline.id}`)}`,
      ),
    );

    // Selecting it again takes it back out.
    selectFilterOption('Client', 'Acme');
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`client=${brightline.id}`),
    );
    expect(lastRequestTo('/api/signal/posts?')?.url).not.toContain(acme.id);
  });

  it('asks for unbound posts and unclassified posts by their reserved names', async () => {
    await openPlanner();

    selectFilterOption('Client', SIGNAL_CLIENT_UNBOUND_LABEL);
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`client=${SIGNAL_CLIENT_UNBOUND}`),
    );

    selectFilterOption('Campaign', SIGNAL_CAMPAIGN_NONE_LABEL);
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(
        `campaign=${SIGNAL_CAMPAIGN_NONE}`,
      ),
    );
  });

  it('filters by project and by campaign', async () => {
    await openPlanner();

    selectFilterOption('Project', 'Acme rollout');
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`project=${acmeProject.id}`),
    );

    selectFilterOption('Campaign', 'Clarity Campaign');
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`campaign=${clarity.id}`),
    );
  });

  it('sends a debounced, transient copy search that never reaches the address', async () => {
    await openPlanner();

    fireEvent.change(within(filters()).getByPlaceholderText('Search post copy…'), {
      target: { value: 'autumn' },
    });
    await waitFor(() => expect(lastRequestTo('/api/signal/posts?')?.url).toContain('q=autumn'), {
      timeout: 2000,
    });
    expect(new URL(window.location.href, 'http://localhost').search).not.toContain('q=');
  });

  it('clears every durable filter at once and leaves the planner’s month alone', async () => {
    await openPlanner(`/signal?month=2026-09&client=${acme.id}&campaign=${clarity.id}`);

    expect(filterSummary('Client')).toHaveAccessibleName('Client: Acme');
    fireEvent.click(within(filters()).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastRequestTo('/api/signal/posts?')?.url).not.toContain('client='));
    expect(lastRequestTo('/api/signal/posts?')?.url).not.toContain('campaign=');
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
  });

  it('carries the filter scope across a month/view navigation rather than dropping it', async () => {
    await openPlanner(`/signal?month=2026-09&client=${acme.id}`);
    expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`client=${acme.id}`);

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument(),
    );
    expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`client=${acme.id}`);
  });

  it('dismisses open filters on Escape and outside pointer, returning focus to the summary', async () => {
    await openPlanner();

    const summary = filterSummary('Client');
    fireEvent.click(summary);
    const details = summary.closest('details')!;
    expect(details.open).toBe(true);

    fireEvent.keyDown(summary, { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(details.open).toBe(false);
  });

  it('always offers unbound client and no campaign, even when there are no named options', async () => {
    testState.clientsPayload = [];
    testState.projectsPayload = [];
    testState.signalCampaignsPayload = [];
    await openPlanner();

    expect(filterSummary('Client')).toHaveAccessibleName('Client: All clients');
    expect(filterSummary('Project')).toHaveAccessibleName('Project: All projects');
    expect(filterSummary('Campaign')).toHaveAccessibleName('Campaign: All campaigns');

    selectFilterOption('Client', SIGNAL_CLIENT_UNBOUND_LABEL);
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(`client=${SIGNAL_CLIENT_UNBOUND}`),
    );
    selectFilterOption('Campaign', SIGNAL_CAMPAIGN_NONE_LABEL);
    await waitFor(() =>
      expect(lastRequestTo('/api/signal/posts?')?.url).toContain(
        `campaign=${SIGNAL_CAMPAIGN_NONE}`,
      ),
    );
  });
});

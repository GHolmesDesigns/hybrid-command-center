import {
  App,
  MemoryRouter,
  beforeEach,
  branding,
  describe,
  expect,
  fireEvent,
  it,
  render,
  screen,
  signalPost,
  testState,
  waitFor,
  within,
} from './App.test-setup';
import type { ProviderReconcilePreview, SignalPublication } from '../../shared/publish';

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
  postId: 'drifted',
  state: 'SUBMITTED',
  provider: 'post-bridge',
  providerPostId: 'provider-1',
  scheduledInstant: '2026-09-20T13:00:00.000Z',
  timezone: 'America/New_York',
  sentCaption: 'The caption that went out',
  sentMedia: [],
  sentChannels: ['x'],
  targets: [
    { channel: 'x', platform: 'twitter', accountId: 4, handle: '@gholmes', mode: 'AUTOMATIC' },
  ],
  checkAttempts: 0,
  createdAt: '2026-09-14T09:00:00.000Z',
  updatedAt: '2026-09-14T09:00:00.000Z',
  ...overrides,
});

const comparison = (
  overrides: Partial<ProviderReconcilePreview> = {},
): ProviderReconcilePreview => ({
  publicationId: 'publication-1',
  postId: 'drifted',
  record: {
    providerPostId: 'provider-1',
    state: 'SCHEDULED',
    caption: 'The caption that went out',
    scheduledInstant: '2026-09-20T13:00:00.000Z',
    mediaUrls: [],
    accountIds: [4],
  },
  reconcileHash: 'b'.repeat(64),
  diffs: [
    {
      field: 'caption',
      changed: true,
      local: 'The caption after the edit',
      remote: 'The caption that went out',
    },
    {
      field: 'schedule',
      changed: false,
      local: '2026-09-20T13:00:00.000Z',
      remote: '2026-09-20T13:00:00.000Z',
    },
    { field: 'media', changed: false, local: 'None', remote: 'None' },
    { field: 'accounts', changed: false, local: '4', remote: '4' },
  ],
  changed: ['caption'],
  actions: [
    { action: 'UPDATE_CONTENT', available: true, refusals: [] },
    {
      action: 'UPDATE_SCHEDULE',
      available: false,
      refusals: ['The provider is already on this instant.'],
    },
    { action: 'CANCEL', available: true, refusals: [] },
    { action: 'RESTORE_AND_RESUBMIT', available: true, refusals: [] },
  ],
  warnings: [],
  refusals: [],
  ...overrides,
});

/**
 * The post the provider is holding, beside the post Signal holds.
 *
 * The card these cases belong to is about not letting an edit go out by accident: a Signal edit
 * says so and stops, the difference is read before anything is pressed, and every action is either
 * offered or replaced by the reason it is not. So each case here is one of those three claims.
 */
describe('Signal provider reconciliation', () => {
  beforeEach(() => {
    const post = signalPost('drifted', 'The caption after the edit', '2026-09-14', {
      channels: ['x'],
      status: 'SCHEDULED',
    });
    testState.signalPostsPayload = [post];
  });

  const openEditor = async () => {
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The caption after the edit' }));
    return screen.findByRole('region', { name: 'Delivery' });
  };

  it('says a Signal edit needs a provider update, and asks the provider nothing to say it', async () => {
    testState.publicationsPayload = [publication({ driftFields: ['caption'] })];
    const delivery = await openEditor();

    expect(delivery).toHaveTextContent('Provider update required');
    expect(delivery).toHaveTextContent('Caption');
    expect(delivery).toHaveTextContent('The provider still holds the earlier version.');
    // The banner is local arithmetic. Nothing was read from the provider and nothing was written
    // to it, which is the difference between reporting drift and acting on it.
    expect(testState.providerApplyRequests).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Provider comparison' })).toBeNull();
  });

  it('shows both sides of the difference and every action with its own verdict', async () => {
    testState.publicationsPayload = [publication({ driftFields: ['caption'] })];
    testState.providerReconcilePayload = comparison();
    const delivery = await openEditor();

    fireEvent.click(within(delivery).getByRole('button', { name: 'Compare with provider' }));
    const panel = await screen.findByRole('region', { name: 'Provider comparison' });

    expect(panel).toHaveTextContent('Scheduled with the provider');
    expect(panel).toHaveTextContent('1 field differs.');
    // Both values, side by side. A merged "the caption changed" would leave the reader working out
    // what it used to be, which is the one thing they need in order to choose.
    expect(panel).toHaveTextContent('The caption after the edit');
    expect(panel).toHaveTextContent('The caption that went out');
    // The changed row is said as well as painted.
    expect(panel).toHaveTextContent('differs');

    expect(within(panel).getByRole('button', { name: 'Update provider content' })).toBeEnabled();
    // A refused action is replaced by its reason rather than left as a disabled control whose
    // explanation lives in a tooltip.
    expect(within(panel).queryByRole('button', { name: 'Update provider schedule' })).toBeNull();
    expect(panel).toHaveTextContent('The provider is already on this instant.');
  });

  it('confirms an action with the token the comparison returned, and rereads afterwards', async () => {
    testState.publicationsPayload = [publication({ driftFields: ['caption'] })];
    testState.providerReconcilePayload = comparison();
    testState.providerApplyPayload = publication({ sentCaption: 'The caption after the edit' });
    const delivery = await openEditor();

    fireEvent.click(within(delivery).getByRole('button', { name: 'Compare with provider' }));
    const panel = await screen.findByRole('region', { name: 'Provider comparison' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Update provider content' }));

    await waitFor(() => expect(testState.providerApplyRequests).toHaveLength(1));
    expect(testState.providerApplyRequests[0]).toEqual({
      action: 'UPDATE_CONTENT',
      reconcileHash: 'b'.repeat(64),
    });
    // The panel closes on success: a restore answers with a different publication, so a panel left
    // open would be describing a record that no longer exists.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Provider comparison' })).toBeNull(),
    );
  });

  it('will not offer to cancel a post the provider has already published', async () => {
    testState.publicationsPayload = [publication()];
    testState.providerReconcilePayload = comparison({
      record: {
        providerPostId: 'provider-1',
        state: 'PUBLISHED',
        caption: 'The caption that went out',
        scheduledInstant: '2026-09-20T13:00:00.000Z',
        mediaUrls: [],
        accountIds: [4],
      },
      changed: [],
      warnings: ['The provider has already published this. Nothing here can unpublish it.'],
      actions: [
        {
          action: 'UPDATE_CONTENT',
          available: false,
          refusals: ['This is already published, so the provider will not take a change to it.'],
        },
        {
          action: 'UPDATE_SCHEDULE',
          available: false,
          refusals: ['This is already published, so the provider will not take a change to it.'],
        },
        {
          action: 'CANCEL',
          available: false,
          refusals: [
            'This is already published. A published post cannot be cancelled through the scheduled-or-draft path, and this app will not try.',
          ],
        },
        {
          action: 'RESTORE_AND_RESUBMIT',
          available: false,
          refusals: ['This is already published, so the provider will not take a change to it.'],
        },
      ],
    });
    const delivery = await openEditor();

    fireEvent.click(within(delivery).getByRole('button', { name: 'Compare with provider' }));
    const panel = await screen.findByRole('region', { name: 'Provider comparison' });

    expect(panel).toHaveTextContent('Already published');
    expect(panel).toHaveTextContent('A published post cannot be cancelled');
    // Every action is named and every one is refused, so the panel says what is impossible rather
    // than quietly omitting it.
    for (const label of [
      'Update provider content',
      'Update provider schedule',
      'Cancel provider post',
      'Restore from Signal and resubmit',
    ])
      expect(within(panel).queryByRole('button', { name: label })).toBeNull();
  });

  it('surfaces a refused commit and takes the comparison again', async () => {
    testState.publicationsPayload = [publication({ driftFields: ['caption'] })];
    testState.providerReconcilePayload = comparison();
    testState.providerApplyError =
      'The post or the provider changed after this comparison was taken.';
    const delivery = await openEditor();

    fireEvent.click(within(delivery).getByRole('button', { name: 'Compare with provider' }));
    const panel = await screen.findByRole('region', { name: 'Provider comparison' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Update provider content' }));

    expect(await screen.findByText(/changed after this comparison was taken/)).toBeInTheDocument();
    // The panel is still there, showing a freshly taken comparison rather than the one the
    // refusal just contradicted.
    expect(await screen.findByRole('region', { name: 'Provider comparison' })).toBeInTheDocument();
  });
});

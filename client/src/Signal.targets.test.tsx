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
import type { PublishChannelReport, PublishPreview } from '../../shared/publish';
import type { PublishVariantScope } from '../../shared/publish-variants';

/**
 * Choosing which accounts a channel publishes to, in the preview (C77).
 *
 * Three claims worth holding here, because each is easy to break without a type error:
 *
 * 1. **Nothing ticked is not "send nowhere".** The panel says so in words, because an empty set of
 *    checkboxes otherwise reads as a decision the person did not make.
 * 2. **The boxes are the accounts the preview was built from**, which is the same list the save
 *    route validates against — so a box you can tick is never one the save refuses.
 * 3. **Every chosen account answers for itself**, refusals included, rather than being merged into
 *    one sentence about the platform.
 */

const openSignal = async (entry = '/signal?month=2026-09') => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await screen.findByRole('heading', { level: 1, name: 'Content planner' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
};

const allBase = (): Record<string, PublishVariantScope> => ({
  caption: 'BASE',
  mediaUrls: 'BASE',
  postKind: 'BASE',
  title: 'BASE',
  firstComment: 'BASE',
  discloseSyntheticMedia: 'BASE',
  coverImage: 'BASE',
  thumbnail: 'BASE',
});

const content = (caption: string) =>
  ({
    caption,
    mediaUrls: [],
    postKind: 'POST',
    discloseSyntheticMedia: false,
    deliveryMode: 'AUTOMATIC',
    sources: allBase(),
  }) as unknown as PublishChannelReport['content'];

const CONNECTED = [
  { id: 902, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: 906, platform: 'facebook', handle: 'wildeyephoto', name: 'Wild Eye Photography' },
  { id: 901, platform: 'twitter', handle: '@gholmes', name: 'G.Holmes Designs' },
];

const preview = (overrides: Partial<PublishPreview> = {}): PublishPreview => ({
  available: true,
  postId: 'target-post',
  planHash: 'a'.repeat(64),
  caption: 'The post itself',
  scheduledInstant: '2026-09-14T13:00:00.000Z',
  timezone: 'America/New_York',
  targets: [],
  channels: [
    {
      channel: 'fb',
      platform: 'facebook',
      kind: 'POST',
      mode: 'AUTOMATIC',
      status: 'READY',
      accountId: 902,
      handle: 'gholmesdesigns',
      content: content('The post itself'),
      refusals: [],
      warnings: [],
    },
  ],
  connectedAccounts: CONNECTED,
  warnings: [],
  refusals: [],
  ...overrides,
});

const openPreview = async () => {
  testState.signalPostsPayload = [
    signalPost('target-post', 'A post for two pages', '2026-09-14', { channels: ['fb'] }),
  ];
  await openSignal();
  fireEvent.click(screen.getByRole('button', { name: 'Edit A post for two pages' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show preview' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
  return within(await screen.findByRole('group', { name: 'Accounts' }));
};

describe('choosing a channel’s accounts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers the accounts connected for that platform, and no others', async () => {
    testState.publishPreviewPayload = preview();
    const accounts = await openPreview();
    expect(accounts.getByRole('checkbox', { name: 'gholmesdesigns' })).toBeInTheDocument();
    expect(accounts.getByRole('checkbox', { name: 'wildeyephoto' })).toBeInTheDocument();
    // The X account is connected but belongs to another platform, so it is not a choice here.
    expect(accounts.queryByRole('checkbox', { name: '@gholmes' })).not.toBeInTheDocument();
  });

  it('says that choosing nothing is not choosing to send nowhere', async () => {
    testState.publishPreviewPayload = preview();
    const accounts = await openPreview();
    expect(accounts.getByText(/No account chosen/)).toBeInTheDocument();
    expect(accounts.getByRole('checkbox', { name: 'gholmesdesigns' })).not.toBeChecked();
  });

  it('shows what is already chosen, and counts it', async () => {
    testState.publishPreviewPayload = preview({
      selectedTargets: [
        { channel: 'fb', providerAccountId: 902 },
        { channel: 'fb', providerAccountId: 906 },
      ],
    });
    const accounts = await openPreview();
    expect(accounts.getByRole('checkbox', { name: 'gholmesdesigns' })).toBeChecked();
    expect(accounts.getByRole('checkbox', { name: 'wildeyephoto' })).toBeChecked();
    expect(accounts.getByText(/Publishing to 2 chosen accounts/)).toBeInTheDocument();
  });

  it('keeps Save accounts unavailable until something actually changes', async () => {
    testState.publishPreviewPayload = preview();
    const accounts = await openPreview();
    expect(accounts.getByRole('button', { name: 'Save accounts' })).toBeDisabled();
    fireEvent.click(accounts.getByRole('checkbox', { name: 'wildeyephoto' }));
    expect(accounts.getByRole('button', { name: 'Save accounts' })).toBeEnabled();
  });

  it('saves the whole selection and takes the preview again', async () => {
    testState.publishPreviewPayload = preview();
    const accounts = await openPreview();
    fireEvent.click(accounts.getByRole('checkbox', { name: 'gholmesdesigns' }));
    fireEvent.click(accounts.getByRole('checkbox', { name: 'wildeyephoto' }));
    fireEvent.click(accounts.getByRole('button', { name: 'Save accounts' }));

    await waitFor(() =>
      expect(requests.some((entry) => entry.url.endsWith('/publish-targets'))).toBe(true),
    );
    const save = requests.find((entry) => entry.url.endsWith('/publish-targets'));
    expect(save?.method).toBe('PUT');
    expect(save?.body).toMatchObject({
      targets: [{ channel: 'fb', providerAccountIds: [902, 906] }],
    });
    // The plan hash covers the chosen ids, so the preview has to be retaken before anything can be
    // confirmed against it.
    await waitFor(() =>
      expect(
        requests.filter((entry) => entry.url.endsWith('/publish/preview')).length,
      ).toBeGreaterThan(1),
    );
  });

  it('unticks an account it already had', async () => {
    testState.publishPreviewPayload = preview({
      selectedTargets: [
        { channel: 'fb', providerAccountId: 902 },
        { channel: 'fb', providerAccountId: 906 },
      ],
    });
    const accounts = await openPreview();
    fireEvent.click(accounts.getByRole('checkbox', { name: 'wildeyephoto' }));
    fireEvent.click(accounts.getByRole('button', { name: 'Save accounts' }));
    await waitFor(() =>
      expect(requests.some((entry) => entry.url.endsWith('/publish-targets'))).toBe(true),
    );
    expect(requests.find((entry) => entry.url.endsWith('/publish-targets'))?.body).toMatchObject({
      targets: [{ channel: 'fb', providerAccountIds: [902] }],
    });
  });
});

describe('each chosen account answers for itself', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names every account with its own caption and its own refusal', async () => {
    testState.publishPreviewPayload = preview({
      selectedTargets: [
        { channel: 'fb', providerAccountId: 902 },
        { channel: 'fb', providerAccountId: 906 },
      ],
      channels: [
        {
          channel: 'fb',
          platform: 'facebook',
          kind: 'POST',
          mode: 'AUTOMATIC',
          status: 'BLOCKED',
          accountId: 902,
          handle: 'gholmesdesigns',
          content: content('For the studio'),
          targets: [
            {
              accountId: 902,
              handle: 'gholmesdesigns',
              status: 'READY',
              content: content('For the studio'),
              refusals: [],
              warnings: [],
            },
            {
              accountId: 906,
              handle: 'wildeyephoto',
              status: 'BLOCKED',
              content: content('For the gallery'),
              refusals: ['Wild Eye Photography is no longer connected.'],
              warnings: [],
            },
          ],
          refusals: [],
          warnings: [],
        },
      ],
    });
    await openPreview();
    const panel = within(screen.getByRole('tabpanel'));
    // Twice on purpose: the channel level describes the first chosen account, so a reader that
    // predates per-account rows still sees something true.
    expect(panel.getAllByText('For the studio').length).toBeGreaterThanOrEqual(2);
    expect(panel.getByText('For the gallery')).toBeInTheDocument();
    // The refusal belongs to the account that caused it, not to the platform.
    expect(panel.getByText('Wild Eye Photography is no longer connected.')).toBeInTheDocument();
  });

  it('shows no per-account rows at all where nobody chose', async () => {
    testState.publishPreviewPayload = preview();
    await openPreview();
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.queryByText('For the studio')).not.toBeInTheDocument();
  });
});

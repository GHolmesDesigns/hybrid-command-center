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
 * Platform and account content variants in the composer, and the preview they feed.
 *
 * The two claims this file is here to hold: a field exists only where the provider would carry it,
 * and nothing remote is fetched until the preview is asked for. Both are easy to break by accident
 * — the first by adding a control without asking the contract, the second by rendering a thumbnail
 * one component higher — and neither shows up in a type error.
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

const IMAGE = 'https://cdn.example.com/campaign.jpg';
const VIDEO = 'https://cdn.example.com/campaign.mp4';

const allBase = (): Record<string, PublishVariantScope> => ({
  caption: 'BASE',
  mediaUrls: 'BASE',
  postKind: 'BASE',
  title: 'BASE',
  firstComment: 'BASE',
  discloseSyntheticMedia: 'BASE',
  coverImageUrl: 'BASE',
  thumbnailUrl: 'BASE',
});

const report = (
  overrides: Partial<PublishChannelReport> & Pick<PublishChannelReport, 'channel'>,
): PublishChannelReport => ({
  platform: 'twitter',
  kind: 'POST',
  status: 'READY',
  refusals: [],
  warnings: [],
  ...overrides,
  content: {
    caption: 'The effective text',
    mediaUrls: [],
    postKind: 'POST',
    discloseSyntheticMedia: false,
    deliveryMode: 'AUTOMATIC',
    sources: allBase() as PublishChannelReport['content'] extends undefined
      ? never
      : Record<string, PublishVariantScope>,
    ...overrides.content,
  } as PublishChannelReport['content'],
});

const preview = (channels: PublishChannelReport[]): PublishPreview => ({
  available: true,
  postId: 'variant-post',
  planHash: 'a'.repeat(64),
  caption: 'The post itself',
  scheduledInstant: '2026-09-14T13:00:00.000Z',
  timezone: 'America/New_York',
  targets: [],
  channels,
  warnings: [],
  refusals: [],
});

describe('Signal content variants', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers each platform only the fields the provider would carry for it', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'One post, several channels', '2026-09-14', {
        channels: ['x', 'yt', 'blog'],
        mediaUrls: [VIDEO],
        format: 'VIDEO',
      }),
    ];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit One post, several channels' }));

    // X takes a first comment and no title; YouTube takes a title and no first comment. Blog
    // reaches no provider at all, so it is not offered as something to tailor.
    const x = within(screen.getByRole('group', { name: 'X' }));
    expect(x.getByLabelText('Caption for X')).toBeInTheDocument();
    expect(x.getByLabelText('First comment')).toBeInTheDocument();
    expect(x.queryByLabelText('Title')).not.toBeInTheDocument();

    const youtube = within(screen.getByRole('group', { name: 'YouTube' }));
    expect(youtube.getByLabelText(/^Title/)).toBeInTheDocument();
    expect(youtube.queryByLabelText('First comment')).not.toBeInTheDocument();
    // No platform records a chosen cover or thumbnail, so neither is offered anywhere.
    expect(screen.queryByLabelText('Cover image')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Thumbnail')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Blog' })).not.toBeInTheDocument();
  });

  it('saves the tailored layers and holds the preview back until it has', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'Tailor me', '2026-09-14', { channels: ['x'] }),
    ];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tailor me' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show preview' })).toBeEnabled());

    fireEvent.change(screen.getByLabelText('Caption for X'), {
      target: { value: 'The short version' },
    });
    // An unsaved override is not previewable, for the same reason an unsaved post is not: the
    // preview would be of something that is not going out.
    expect(screen.getByRole('button', { name: 'Save changes before preview' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save per-platform content' }));
    await waitFor(() =>
      expect(
        requests.some((entry) => entry.method === 'PUT' && entry.url.endsWith('/variants')),
      ).toBe(true),
    );
    expect(testState.signalVariantsPayload).toEqual([
      { platform: 'twitter', accountId: null, caption: 'The short version' },
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show preview' })).toBeEnabled());
  });

  it('reports a refused override without storing it', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'Tailor me', '2026-09-14', { channels: ['x'] }),
    ];
    testState.signalVariantsError = 'X takes no title from this provider.';
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tailor me' }));
    fireEvent.change(screen.getByLabelText('Caption for X'), { target: { value: 'Short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save per-platform content' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'X takes no title from this provider.',
    );
    expect(testState.signalVariantsPayload).toEqual([]);
  });

  it('loads nothing remote until the preview is asked for, and no video until it is played', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'The post itself', '2026-09-14', {
        channels: ['x'],
        mediaUrls: [IMAGE, VIDEO],
      }),
    ];
    testState.publishPreviewPayload = preview([
      report({
        channel: 'x',
        accountId: 4,
        handle: '@gholmes',
        content: { mediaUrls: [IMAGE, VIDEO] } as PublishChannelReport['content'],
      }),
    ]);
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The post itself' }));
    // The composer lists media as text. Not one element in it asks a remote host for anything.
    expect(document.querySelectorAll('img[src^="https://cdn.example.com"]')).toHaveLength(0);
    expect(document.querySelectorAll('video')).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Show preview' }));
    const panel = await screen.findByRole('tabpanel');
    const image = panel.querySelector('img') as HTMLImageElement;
    expect(image).toHaveAttribute('src', IMAGE);
    // The one attribute HTML defines for this, on the element it is defined for.
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    // A video is not fetched by the preview at all: it takes its own press, and even then it
    // arrives with controls rather than playing.
    expect(panel.querySelectorAll('video')).toHaveLength(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Load this video' }));
    const video = panel.querySelector('video') as HTMLVideoElement;
    expect(video).toHaveAttribute('src', VIDEO);
    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(true);
  });

  it('gives broken media a usable fallback rather than a gap', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'The post itself', '2026-09-14', {
        channels: ['x'],
        mediaUrls: [IMAGE],
      }),
    ];
    testState.publishPreviewPayload = preview([
      report({
        channel: 'x',
        accountId: 4,
        handle: '@gholmes',
        content: { mediaUrls: [IMAGE] } as PublishChannelReport['content'],
      }),
    ]);
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The post itself' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show preview' }));
    const panel = await screen.findByRole('tabpanel');
    fireEvent.error(panel.querySelector('img') as HTMLImageElement);
    expect(panel).toHaveTextContent('This media could not be shown here.');
    // The address is still readable and still openable, which is what makes the fallback usable.
    expect(within(panel).getByRole('link', { name: /Open/ })).toHaveAttribute('href', IMAGE);
    expect(panel).toHaveTextContent(IMAGE);
  });

  it('gives each target its own tab, with the text and options that target receives', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'The post itself', '2026-09-14', {
        channels: ['x', 'yt'],
        mediaUrls: [VIDEO],
        format: 'VIDEO',
      }),
    ];
    testState.publishPreviewPayload = preview([
      report({
        channel: 'x',
        accountId: 4,
        handle: '@gholmes',
        content: {
          caption: 'The short version',
          mediaUrls: [VIDEO],
          postKind: 'POST',
          firstComment: 'gholmesdesigns.com',
          discloseSyntheticMedia: false,
          deliveryMode: 'AUTOMATIC',
          sources: { ...allBase(), caption: 'PLATFORM', firstComment: 'ACCOUNT' },
        } as PublishChannelReport['content'],
      }),
      report({
        channel: 'yt',
        platform: 'youtube',
        accountId: 7,
        handle: '@gholmesdesigns',
        status: 'BLOCKED',
        refusals: ['YouTube limits the title to 100 characters and this one is 101. Remove 1.'],
        content: {
          caption: 'The long form post',
          mediaUrls: [VIDEO],
          postKind: 'REEL',
          title: 'A title',
          discloseSyntheticMedia: true,
          deliveryMode: 'MANUAL_FINISH',
          sources: { ...allBase(), title: 'PLATFORM', postKind: 'PLATFORM' },
        } as PublishChannelReport['content'],
      }),
    ]);
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The post itself' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show preview' }));
    const confirmation = await screen.findByRole('region', { name: 'Publish confirmation' });
    const tabs = within(confirmation).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'X → @gholmes',
      'YouTube → @gholmesdesigns',
    ]);

    // The selected target's own text, the layer it came from, its instant and its delivery mode.
    let panel = within(confirmation).getByRole('tabpanel');
    expect(panel).toHaveTextContent('The short version');
    expect(panel).toHaveTextContent('Caption from the platform override');
    expect(panel).toHaveTextContent('First comment from the account override');
    expect(panel).toHaveTextContent('2026-09-14 at 09:00 in America/New_York');
    expect(panel).toHaveTextContent('Provider instant: 2026-09-14T13:00:00.000Z');
    expect(panel).toHaveTextContent('Sent by the provider');

    // Arrow keys move between targets, and the second target answers for itself.
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    panel = within(confirmation).getByRole('tabpanel');
    expect(panel).toHaveTextContent('The long form post');
    expect(panel).toHaveTextContent('Title: A title');
    expect(panel).toHaveTextContent('reel or short');
    expect(panel).toHaveTextContent('Finished by hand in the platform app');
    expect(panel).toHaveTextContent('Synthetic-media disclosure: included');
    expect(panel).toHaveTextContent('YouTube limits the title to 100 characters');
    // A blocked target blocks the send, whichever tab happens to be open.
    expect(screen.getByRole('button', { name: 'Confirm and submit' })).toBeDisabled();
  });

  it('saves an account override from its own tab and re-checks the plan', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'The post itself', '2026-09-14', { channels: ['x'] }),
    ];
    testState.publishPreviewPayload = preview([
      report({ channel: 'x', accountId: 4, handle: '@gholmes' }),
    ]);
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The post itself' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show preview' }));
    const panel = await screen.findByRole('tabpanel');
    fireEvent.click(within(panel).getByText('Override for @gholmes only'));
    fireEvent.change(within(panel).getByLabelText('Caption for X'), {
      target: { value: 'Only for this handle' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: /Save and re-check/ }));
    await waitFor(() =>
      expect(testState.signalVariantsPayload).toEqual([
        { platform: 'twitter', accountId: 4, caption: 'Only for this handle' },
      ]),
    );
    // The plan is re-read rather than left showing content it was not built from.
    await waitFor(() =>
      expect(
        requests.filter((entry) => entry.url.endsWith('/publish/preview')).length,
      ).toBeGreaterThan(1),
    );
  });
});

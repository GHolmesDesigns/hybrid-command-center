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
import { urlPostMedia } from '../../shared/signal-media';

/**
 * Platform and account content variants in the composer, and the preview they feed.
 *
 * The claims this file is here to hold: a field exists only where the provider would carry it,
 * nothing remote is fetched until Show preview, and public image/video bytes still need an explicit
 * opt-in after that because they share the viewer's IP with the media host. Drive, PDF, unknown,
 * and signed addresses stay text. Easy to break by accident — none of it shows up in a type error.
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
  coverImage: 'BASE',
  thumbnail: 'BASE',
});

const report = (
  overrides: Partial<PublishChannelReport> & Pick<PublishChannelReport, 'channel'>,
): PublishChannelReport => ({
  platform: 'twitter',
  kind: 'POST',
  mode: 'AUTOMATIC',
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
    // A role control exists exactly where the provider names the field. X and YouTube are the two
    // platforms on this post: YouTube gets the thumbnail Post Bridge names for it, and neither
    // platform gets a cover, because the provider defines one only for Instagram.
    expect(youtube.getByText('Thumbnail')).toBeInTheDocument();
    expect(youtube.getByLabelText('Add a Drive file as the YouTube thumbnail')).toBeInTheDocument();
    // And the control says what it does today rather than implying a delivery nobody has watched.
    expect(youtube.getByText(/has not verified that it is accepted/)).toBeInTheDocument();
    expect(youtube.getByText(/has no verified provider disclosure control/)).toHaveTextContent(
      'It does not by itself guarantee platform, advertising, or legal compliance.',
    );
    expect(x.queryByText('Thumbnail')).not.toBeInTheDocument();
    expect(screen.queryByText('Cover image')).not.toBeInTheDocument();
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

  /**
   * A role is chosen the way the post's own media is chosen, and stated to the server the same way.
   *
   * The composer holds a whole descriptor so it can show what Drive said about the file; the request
   * carries the source and the address, because nothing about a Drive file's metadata is ever
   * accepted from a caller.
   */
  it('chooses a Drive file for a role, sends it as a link, and reports a refusal', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'Tailor me', '2026-09-14', {
        channels: ['yt'],
        mediaUrls: [VIDEO],
        format: 'VIDEO',
      }),
    ];
    testState.driveMediaError = 'That is a Drive folder, and a post carries one file at a time.';
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tailor me' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show preview' })).toBeEnabled());

    const role = document.querySelector('[data-role="THUMBNAIL"]') as HTMLElement;
    const within_ = within(role);
    // A recheck is an edit, so it is not offered against a role that is not stored yet.
    expect(within_.queryByRole('button', { name: /Recheck/ })).not.toBeInTheDocument();

    fireEvent.change(within_.getByLabelText('Add a Drive file as the YouTube thumbnail'), {
      target: { value: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv' },
    });
    fireEvent.click(within_.getByRole('button', { name: 'Use this Drive file' }));
    expect(await within_.findByRole('status')).toHaveTextContent(/carries one file at a time/);

    testState.driveMediaError = null;
    testState.driveMediaPayload = {
      source: 'DRIVE',
      url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view',
      driveFileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      driveName: 'cover.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      driveVersion: '7',
      driveModifiedAt: '2026-03-01T12:00:00.000Z',
      driveChecksum: null,
      driveVerifiedAt: '2026-08-20T09:00:00.000Z',
    };
    fireEvent.change(within_.getByLabelText('Add a Drive file as the YouTube thumbnail'), {
      target: { value: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view' },
    });
    fireEvent.click(within_.getByRole('button', { name: 'Use this Drive file' }));
    expect(await within_.findByText('cover.png')).toBeInTheDocument();
    expect(within_.getByText('image/png · 2.0 KB')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save per-platform content' }));
    await waitFor(() =>
      expect(
        requests.some((entry) => entry.method === 'PUT' && entry.url.endsWith('/variants')),
      ).toBe(true),
    );
    // The link, not the metadata: the server resolves it again through the one parsing rule.
    expect(testState.signalVariantsPayload).toEqual([
      {
        platform: 'youtube',
        accountId: null,
        thumbnail: {
          source: 'DRIVE',
          url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view',
        },
      },
    ]);
  });

  it('rechecks a stored role and removes one on request', async () => {
    testState.signalPostsPayload = [
      signalPost('variant-post', 'Tailor me', '2026-09-14', {
        channels: ['yt'],
        mediaUrls: [VIDEO],
        format: 'VIDEO',
      }),
    ];
    const stored = {
      source: 'DRIVE' as const,
      url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view',
      driveFileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      driveName: 'cover.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      driveVersion: '7',
      driveModifiedAt: '2026-03-01T12:00:00.000Z',
      driveChecksum: null,
      driveVerifiedAt: '2026-08-20T09:00:00.000Z',
    };
    testState.signalVariantsPayload = [
      { platform: 'youtube', accountId: null, thumbnail: stored, updatedAt: 'saved' },
    ];
    testState.driveRecheckPayload = { ...stored, sizeBytes: 3072, driveVersion: '9' };
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Tailor me' }));
    const role = (await waitFor(() =>
      document.querySelector('[data-role="THUMBNAIL"]'),
    )) as HTMLElement;
    const within_ = within(role);
    await within_.findByText('cover.png');

    fireEvent.click(within_.getByRole('button', { name: 'Recheck thumbnail' }));
    await waitFor(() => expect(within_.getByText('image/png · 3.0 KB')).toBeInTheDocument());

    // Removing it puts the field back to the address input, and nothing is stored until it is saved.
    fireEvent.click(within_.getByRole('button', { name: 'Remove thumbnail' }));
    expect(within_.getByLabelText('Thumbnail address for YouTube')).toHaveValue('');
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

  it('loads nothing remote until public previews are opted into, and no video until it is played', async () => {
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
    // Show preview still keeps every address as text; the IP note and the text-only choice are the
    // second gate before any browser request to a media host.
    expect(panel.querySelectorAll('img')).toHaveLength(0);
    expect(panel.querySelectorAll('video')).toHaveLength(0);
    expect(panel).toHaveTextContent('shares your IP address with it');
    expect(
      within(panel).getByRole('button', { name: 'Show public media previews' }),
    ).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(within(panel).getByRole('button', { name: 'Show public media previews' }));
    const image = panel.querySelector('img') as HTMLImageElement;
    expect(image).toHaveAttribute('src', IMAGE);
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(panel.querySelectorAll('video')).toHaveLength(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Load this video' }));
    const video = panel.querySelector('video') as HTMLVideoElement;
    expect(video).toHaveAttribute('src', VIDEO);
    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(true);

    fireEvent.click(within(panel).getByRole('button', { name: 'Show text only' }));
    expect(panel.querySelectorAll('img')).toHaveLength(0);
    expect(panel.querySelectorAll('video')).toHaveLength(0);
  });

  it('keeps Drive, PDF, unknown, and signed addresses as text even after opting in', async () => {
    const SIGNED = 'https://cdn.example.com/campaign.jpg?token=1';
    const PDF = 'https://cdn.example.com/brief.pdf';
    const UNKNOWN = 'https://cdn.example.com/share';
    const drive = {
      source: 'DRIVE' as const,
      url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view',
      driveFileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      driveName: 'launch.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
      driveVersion: '3',
      driveModifiedAt: '2026-03-01T12:00:00.000Z',
      driveChecksum: null,
      driveVerifiedAt: '2026-08-20T09:00:00.000Z',
    };
    testState.signalPostsPayload = [
      signalPost('variant-post', 'The post itself', '2026-09-14', {
        channels: ['x'],
        media: [drive, urlPostMedia(SIGNED), urlPostMedia(PDF), urlPostMedia(UNKNOWN)],
      }),
    ];
    testState.publishPreviewPayload = preview([
      report({
        channel: 'x',
        accountId: 4,
        handle: '@gholmes',
        content: {
          mediaUrls: [drive.url, SIGNED, PDF, UNKNOWN],
        } as PublishChannelReport['content'],
      }),
    ]);
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The post itself' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show preview' }));
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).queryByRole('button', { name: 'Show public media previews' })).toBeNull();
    expect(panel).toHaveTextContent('can be previewed here');
    expect(panel).toHaveTextContent('Drive file · launch.jpg');
    expect(panel).toHaveTextContent('signed or time-bounded');
    expect(panel).toHaveTextContent('A PDF is not shown here');
    expect(panel).toHaveTextContent('no file extension');
    expect(panel.querySelectorAll('img')).toHaveLength(0);
    expect(panel.querySelectorAll('video')).toHaveLength(0);
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
    fireEvent.click(within(panel).getByRole('button', { name: 'Show public media previews' }));
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
    expect(panel).toHaveTextContent('Automatic publishing');

    // Arrow keys move between targets, and the second target answers for itself.
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    panel = within(confirmation).getByRole('tabpanel');
    expect(panel).toHaveTextContent('The long form post');
    expect(panel).toHaveTextContent('Title: A title');
    expect(panel).toHaveTextContent('reel or short');
    expect(panel).toHaveTextContent('Manual finish required');
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

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

const openSignal = async (entry = '/signal?month=2026-09') => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  const heading = await screen.findByRole('heading', { level: 1, name: 'Content planner' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  return heading;
};

/** The size of copy the campaign posts actually run to, ending in a line only a full view shows. */
const LONG = `A thousand-character post ${'with durable copy '.repeat(70)}and a closing line.`;

describe('Signal planner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // A local late-night clock west of UTC: the planner must still call this September 14.
    vi.setSystemTime(new Date(2026, 8, 14, 23, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the Calendar view URL contract and keeps local dates in all three views', async () => {
    testState.signalPostsPayload = [
      signalPost('today', 'The local-date post', '2026-09-14'),
      signalPost('outside', 'Outside this week', '2026-09-21'),
    ];
    await openSignal('/signal?view=week&month=2026-09&date=2026-09-14');

    expect(screen.getByRole('button', { name: 'Week', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '2026-09-14' })).toHaveTextContent(
      'The local-date post',
    );
    expect(screen.queryByText('Outside this week')).not.toBeInTheDocument();
    const rangeCall = requests.find((request) => request.url.includes('/api/signal/posts?'));
    expect(rangeCall?.url).toContain('from=2026-09-14');
    expect(rangeCall?.url).toContain('to=2026-09-20');

    fireEvent.click(screen.getByRole('button', { name: 'Today', pressed: false }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Today', pressed: true })).toBeInTheDocument(),
    );
    expect(screen.getAllByRole('region', { name: /^2026-/ })).toHaveLength(1);
    expect(screen.getByRole('region', { name: '2026-09-14' })).toHaveTextContent(
      'The local-date post',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Month', pressed: true })).toBeInTheDocument(),
    );
    expect(screen.getByRole('region', { name: '2026-09-14' })).toHaveTextContent(
      'The local-date post',
    );
  });

  it.each(['today', 'week', 'month'] as const)(
    'edits a scheduled post from the %s view without changing the queue',
    async (view) => {
      testState.signalPostsPayload = [
        signalPost('queued-view', 'Queue stays put', null, { status: 'DRAFT' }),
        signalPost('edit-view', 'Edit in every view', '2026-09-14'),
      ];
      const entry =
        view === 'month'
          ? '/signal?month=2026-09'
          : `/signal?view=${view}&month=2026-09&date=2026-09-14`;
      await openSignal(entry);

      fireEvent.click(screen.getByRole('button', { name: 'Edit Edit in every view' }));
      fireEvent.change(screen.getByLabelText('Content'), {
        target: { value: `Edited from ${view}` },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save post' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByText(`Edited from ${view}`)).toBeInTheDocument();
      expect(
        within(screen.getByRole('complementary', { name: 'Unscheduled queue' })).getByText(
          'Queue stays put',
        ),
      ).toBeInTheDocument();
    },
  );

  it('returns to the current local day and keeps the truncation notice range-aware', async () => {
    testState.signalPostsPayload = [signalPost('now', 'Back to today', '2026-09-14')];
    testState.signalPostsTruncated = true;
    await openSignal('/signal?view=today&month=2025-01&date=2025-01-03');

    expect(
      screen.getByText('This day has more than 500 posts. Only the first 500 are shown.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Today' })[1]!);
    expect(await screen.findByRole('region', { name: '2026-09-14' })).toHaveTextContent(
      'Back to today',
    );
  });

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

  it('warns on every planner surface when X-bound copy carries a link without rewriting it', async () => {
    const warning =
      'X removes links from the post body. Move this link to a reply before publishing.';
    testState.signalPostsPayload = [
      signalPost('queued-link', 'Queue link: gholmesdesigns.com', null, { channels: ['x'] }),
      signalPost('scheduled-link', 'Scheduled link: foo.io/path', '2026-09-14', {
        channels: ['x'],
      }),
      signalPost('other-channel', 'LinkedIn link: gholmesdesigns.com', '2026-09-15', {
        channels: ['li'],
      }),
    ];
    await openSignal();

    const queue = screen.getByRole('complementary', { name: 'Unscheduled queue' });
    expect(within(queue).getByText(warning)).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '2026-09-14' })).getByText(warning),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '2026-09-15' })).queryByText(warning),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole('region', { name: '2026-09-14' })).getByRole('button', {
        name: 'Edit Scheduled link: foo.io/path',
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(warning);
    expect(screen.getByLabelText('Content')).toHaveValue('Scheduled link: foo.io/path');

    fireEvent.click(screen.getByRole('checkbox', { name: 'X' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Content')).toHaveValue('Scheduled link: foo.io/path');
  });

  it('applies a channel preset as an editable starting point and saves channel identifiers', async () => {
    testState.signalPostsPayload = [
      signalPost('preset', 'Choose a distribution set', '2026-09-14', { channels: ['x'] }),
    ];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Choose a distribution set' }));

    fireEvent.change(screen.getByLabelText('Channel preset'), { target: { value: 'short-video' } });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Short-form video applied. You can edit the channels below.',
    );
    expect(screen.getByRole('checkbox', { name: 'Instagram' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'TikTok' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'YouTube' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'X' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'LinkedIn' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'TikTok' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save post' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(requests.find((request) => request.method === 'PATCH')?.body.channels).toEqual([
      'ig',
      'yt',
      'li',
    ]);
  });

  it('shows media count and saves an explicit media reorder from the editor', async () => {
    const first = 'https://cdn.example.com/first.jpg';
    const second = 'https://cdn.example.com/second.mp4';
    testState.signalPostsPayload = [
      signalPost('media', 'A post with media', '2026-09-14', {
        mediaUrls: [first, second],
      }),
    ];
    await openSignal();

    const day = screen.getByRole('region', { name: '2026-09-14' });
    expect(
      within(day).getByText(
        (_content, node) =>
          node?.classList.contains('signal-media-count') === true &&
          node.textContent?.includes('2 media') === true,
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(day).getByRole('button', { name: 'Edit A post with media' }));

    expect(screen.getByLabelText('Media URL 1')).toHaveValue(first);
    expect(screen.getByLabelText('Media URL 2')).toHaveValue(second);
    expect(screen.getByText('image')).toBeInTheDocument();
    expect(screen.getByText('video')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move media 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save post' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.body.mediaUrls).toEqual([second, first]);
  });

  it('refuses an insecure media reference before adding it to a post', async () => {
    testState.signalPostsPayload = [signalPost('media', 'Add media here', null)];
    await openSignal();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Add media here' }));
    fireEvent.change(screen.getByLabelText('Add media URL'), {
      target: { value: 'http://example.com/not-secure.jpg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add media' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Media URLs must be valid https addresses.',
    );
    expect(screen.queryByLabelText('Media URL 1')).not.toBeInTheDocument();
  });

  it('adds, edits and removes a secure media reference before save', async () => {
    testState.signalPostsPayload = [signalPost('media-edit', 'Edit media here', null)];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Edit media here' }));
    fireEvent.change(screen.getByLabelText('Add media URL'), {
      target: { value: 'https://cdn.example.com/first.jpg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add media' }));
    fireEvent.change(screen.getByLabelText('Media URL 1'), {
      target: { value: 'https://cdn.example.com/revised.jpg' },
    });
    expect(screen.getByLabelText('Media URL 1')).toHaveValue('https://cdn.example.com/revised.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Remove media 1' }));
    expect(screen.queryByLabelText('Media URL 1')).not.toBeInTheDocument();
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

  it('shows the exact publishing preview before sending and keeps status as a user write', async () => {
    const post = signalPost('publish', 'Preview this campaign post', '2026-09-14', {
      channels: ['x'],
    });
    testState.signalPostsPayload = [post];
    testState.publishPreviewPayload = {
      available: true,
      postId: post.id,
      planHash: 'a'.repeat(64),
      caption: post.text,
      scheduledInstant: '2026-09-14T13:00:00.000Z',
      timezone: 'America/New_York',
      targets: [
        { channel: 'x', platform: 'twitter', accountId: 4, handle: '@gholmes', mode: 'AUTOMATIC' },
      ],
      channels: [
        {
          channel: 'x',
          platform: 'twitter',
          kind: 'POST',
          mode: 'AUTOMATIC',
          status: 'READY',
          accountId: 4,
          handle: '@gholmes',
          refusals: [],
          warnings: [],
        },
        {
          channel: 'blog',
          platform: null,
          kind: 'POST',
          mode: 'UNSUPPORTED',
          status: 'NOT_AVAILABLE',
          refusals: [],
          warnings: [
            'Blog is not available from this provider. Publish it yourself and mark the post published.',
          ],
        },
      ],
      warnings: [],
      refusals: [],
    };
    testState.publishSubmitPayload = {
      id: 'publication-1',
      postId: post.id,
      state: 'SUBMITTED',
      provider: 'post-bridge',
      providerPostId: 'provider-1',
      scheduledInstant: '2026-09-14T13:00:00.000Z',
      timezone: 'America/New_York',
      sentCaption: post.text,
      sentChannels: ['x'],
      targets: [
        { channel: 'x', platform: 'twitter', accountId: 4, handle: '@gholmes', mode: 'AUTOMATIC' },
      ],
      checkAttempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Preview this campaign post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview publishing' }));
    expect(await screen.findByRole('region', { name: 'Publish confirmation' })).toHaveTextContent(
      'America/New_York',
    );
    // Each channel reports beside the account it resolved to, and the one no provider reaches
    // says so by name rather than going missing from the preview.
    const confirmation = await screen.findByRole('region', { name: 'Publish confirmation' });
    expect(confirmation).toHaveTextContent('X → @gholmes · Ready to send');
    expect(confirmation).toHaveTextContent('Blog · Not available from this provider');
    expect(confirmation).toHaveTextContent('Blog is not available from this provider.');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and submit' }));
    await waitFor(() =>
      expect(
        requests.some((entry) => entry.url.endsWith('/publish') && entry.method === 'POST'),
      ).toBe(true),
    );
    expect(requests.filter((entry) => entry.method === 'PATCH')).toHaveLength(0);
  });

  it('does not offer publishing for blog-only work or unsaved editor changes', async () => {
    testState.signalPostsPayload = [
      signalPost('blog-only', 'Blog stays manual', '2026-09-14', { channels: ['blog'] }),
      signalPost('dirty', 'Save me first', '2026-09-15', { channels: ['x'] }),
    ];
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Blog stays manual' }));
    expect(screen.queryByRole('button', { name: 'Preview publishing' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Save me first' }));
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Unsaved revision' } });
    expect(screen.getByRole('button', { name: 'Save changes before preview' })).toBeDisabled();
  });

  it('refreshes provider delivery and leaves Mark published as an explicit patch', async () => {
    const post = signalPost('delivery', 'Delivered campaign post', '2026-09-14', {
      channels: ['x'],
      status: 'SCHEDULED',
    });
    const submitted: (typeof testState.publicationsPayload)[number] = {
      id: 'publication-2',
      postId: post.id,
      state: 'SUBMITTED' as const,
      provider: 'post-bridge',
      providerPostId: 'provider-2',
      scheduledInstant: '2026-09-14T13:00:00.000Z',
      timezone: 'America/New_York',
      sentCaption: post.text,
      sentChannels: ['x'],
      targets: [
        { channel: 'x', platform: 'twitter', accountId: 4, handle: '@gholmes', mode: 'AUTOMATIC' },
      ],
      checkAttempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    testState.signalPostsPayload = [post];
    testState.publicationsPayload = [submitted];
    testState.publishReconcilePayload = { ...submitted, state: 'CONFIRMED' };
    await openSignal();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Delivered campaign post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh delivery' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark published' }));
    await waitFor(() =>
      expect(requests.find((entry) => entry.method === 'PATCH')?.body.status).toBe('PUBLISHED'),
    );
  });

  it('moves a saved post between queue and grid and reloads both API views', async () => {
    testState.signalPostsPayload = [
      signalPost('queued', 'Schedule this', null, { status: 'DRAFT' }),
    ];
    await openSignal();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Schedule this' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-20' } });
    fireEvent.change(screen.getByLabelText('Planning status'), {
      target: { value: 'SCHEDULED' },
    });
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

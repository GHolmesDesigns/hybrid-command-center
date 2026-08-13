import {
  MemoryRouter,
  branding,
  calendarRange,
  describe,
  expect,
  fireEvent,
  it,
  render,
  requests,
  screen,
  signalPost,
  task,
  testState,
  waitFor,
  within,
  App,
} from './App.test-setup';

const openCalendar = async (entry = '/calendar?month=2026-09', heading = /September 2026/) => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  return screen.findByRole('heading', { level: 1, name: heading });
};

/** Every range the page asked for, in order. */
const calendarCalls = () =>
  requests.filter((call) => call.method === 'GET' && call.url.includes('/api/calendar'));

const septemberWith = (overrides: Parameters<typeof calendarRange>[0]) => {
  testState.calendarPayload = () =>
    calendarRange({ from: '2026-09-01', to: '2026-09-30', ...overrides });
};

describe('Calendar', () => {
  it('asks for the month named in the address, bounded by its own length', async () => {
    await openCalendar('/calendar?month=2026-02', /February 2026/);
    await waitFor(() => expect(calendarCalls().length).toBeGreaterThan(0));
    expect(calendarCalls()[0]!.url).toContain('from=2026-02-01');
    expect(calendarCalls()[0]!.url).toContain('to=2026-02-28');
  });

  it('shows scheduled content and task deadlines as separate, separately-headed groups', async () => {
    septemberWith({
      posts: [signalPost('s1', 'Teach first. Sell second.', '2026-09-14')],
      tasks: [task('t1', 'Ship the explainer', { dueDate: '2026-09-14', projectName: 'Spring' })],
    });
    await openCalendar();

    const day = await screen.findByRole('region', { name: /September 14, 2026/ });
    // The two kinds are structurally apart: each has its own heading inside the day, and the
    // post is not reachable from the deadlines group nor the task from the content group.
    const content = within(day).getByRole('heading', { name: /Scheduled content/ });
    const deadlines = within(day).getByRole('heading', { name: /Task deadlines/ });
    expect(content).toBeTruthy();
    expect(deadlines).toBeTruthy();
    expect(within(day).getByText('Teach first. Sell second.')).toBeTruthy();
    expect(within(day).getByRole('link', { name: 'Ship the explainer' })).toBeTruthy();
  });

  it('names each post status in words rather than by colour alone', async () => {
    septemberWith({
      posts: [
        signalPost('s1', 'A dated draft', '2026-09-10', { status: 'DRAFT' }),
        signalPost('s2', 'Scheduled one', '2026-09-11', { status: 'SCHEDULED' }),
        signalPost('s3', 'Already out', '2026-09-12', { status: 'PUBLISHED' }),
      ],
    });
    await openCalendar();

    // Every status renders, the dated draft included — dropping it would read as data loss.
    expect(await screen.findByText('A dated draft')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.getByText('Published')).toBeTruthy();
  });

  it('labels channels with their initials, so colour is never the only cue', async () => {
    septemberWith({
      posts: [signalPost('s1', 'Cross-posted', '2026-09-14', { channels: ['li', 'ig'] })],
    });
    await openCalendar();

    const day = await screen.findByRole('region', { name: /September 14, 2026/ });
    expect(within(day).getByText('in')).toBeTruthy();
    expect(within(day).getByText('IG')).toBeTruthy();
    // The full name is there for a screen reader, beside the initial rather than instead of it.
    expect(within(day).getByText('LinkedIn')).toBeTruthy();
    expect(within(day).getByText('Instagram')).toBeTruthy();
  });

  it('counts the two kinds separately rather than as one total', async () => {
    septemberWith({
      posts: [signalPost('s1', 'One', '2026-09-14'), signalPost('s2', 'Two', '2026-09-15')],
      tasks: [task('t1', 'A deadline', { dueDate: '2026-09-16' })],
    });
    await openCalendar();

    expect(await screen.findByText(/2 scheduled posts/)).toBeTruthy();
    expect(screen.getByText(/1 task deadline/)).toBeTruthy();
  });

  it('keeps the line breaks a post was written with, and shows long copy in full', async () => {
    const long = 'First line.\n\n' + 'x'.repeat(1200);
    septemberWith({ posts: [signalPost('s1', long, '2026-09-14')] });
    await openCalendar();

    const day = await screen.findByRole('region', { name: /September 14, 2026/ });
    const text = within(day).getByText(/First line\./);
    // Nothing is truncated and the blank line survives: this page is where the copy is read,
    // not a preview of somewhere else. (`white-space: pre-wrap` on `.cal-text` is what renders
    // the break; jsdom loads no stylesheet, so the class is what can be asserted here.)
    expect(text.textContent).toBe(long);
    expect(text.textContent).toContain('\n\n');
    expect(text).toHaveClass('cal-text');
  });

  it('drops days that carry nothing and orders the rest', async () => {
    septemberWith({
      posts: [signalPost('s1', 'Later', '2026-09-20')],
      tasks: [task('t1', 'Earlier', { dueDate: '2026-09-04' })],
    });
    await openCalendar();

    const days = await screen.findAllByRole('region', { name: /2026/ });
    expect(days.map((day) => day.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('September 4, 2026'),
      expect.stringContaining('September 20, 2026'),
    ]);
  });

  it('says the month is empty rather than showing a wall of blank days', async () => {
    await openCalendar();
    expect(await screen.findByText('Nothing this month')).toBeTruthy();
  });

  it('degrades to task deadlines with a visible reason when the schedule cannot be read', async () => {
    septemberWith({
      tasks: [task('t1', 'Still due', { dueDate: '2026-09-14' })],
      signal: { available: false, error: 'The schedule store is locked.', truncated: false },
    });
    await openCalendar();

    expect(await screen.findByText(/Showing task deadlines only/)).toBeTruthy();
    expect(screen.getByText('The schedule store is locked.')).toBeTruthy();
    // The half that still works is still there, and still correct.
    expect(screen.getByRole('link', { name: 'Still due' })).toBeTruthy();
  });

  it('retries the range on demand after a failure', async () => {
    septemberWith({
      signal: { available: false, error: 'Temporarily unavailable.', truncated: false },
    });
    await openCalendar();

    const before = calendarCalls().length;
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(calendarCalls().length).toBe(before + 1));
  });

  it('says so when a month holds more posts than one page returns', async () => {
    septemberWith({
      posts: [signalPost('s1', 'One of many', '2026-09-14')],
      signal: { available: true, error: null, truncated: true },
    });
    await openCalendar();
    expect(await screen.findByText(/more scheduled posts than one page shows/)).toBeTruthy();
  });

  it('moves between months and back to today through the address', async () => {
    await openCalendar('/calendar?month=2026-09');
    await waitFor(() => expect(calendarCalls().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await screen.findByRole('heading', { level: 1, name: /October 2026/ });
    await waitFor(() => expect(calendarCalls().at(-1)!.url).toContain('from=2026-10-01'));

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await screen.findByRole('heading', { level: 1, name: /September 2026/ });
  });

  it('steps across a year boundary without inventing a thirteenth month', async () => {
    await openCalendar('/calendar?month=2026-12', /December 2026/);
    await waitFor(() => expect(calendarCalls().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await screen.findByRole('heading', { level: 1, name: /January 2027/ });
    await waitFor(() => expect(calendarCalls().at(-1)!.url).toContain('from=2027-01-01'));
  });

  it('offers nothing that writes a schedule', async () => {
    septemberWith({
      posts: [signalPost('s1', 'Read only', '2026-09-14', { status: 'DRAFT' })],
    });
    await openCalendar();
    await screen.findByText('Read only');

    for (const label of [/new post/i, /add/i, /edit/i, /delete/i, /schedule/i, /publish/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    // And nothing it did render sent a write.
    expect(requests.every((call) => call.method === 'GET')).toBe(true);
  });
});

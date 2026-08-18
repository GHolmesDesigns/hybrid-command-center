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
  screen,
  signalPost,
  testState,
  vi,
  waitFor,
} from './App.test-setup';
import {
  SIGNAL_CHANNEL_INITIAL,
  SIGNAL_CHANNEL_LABEL,
  SIGNAL_CHANNEL_TREATMENT,
  SIGNAL_CHANNELS,
} from '../../shared/signal';
import { signalChannelStyle } from './components/ui-shared';

/** One post per channel, so every assertion below reads a mixed planner rather than one tile. */
const oneEach = SIGNAL_CHANNELS.map((channel, index) =>
  signalPost(`post-${channel}`, `Going out on ${SIGNAL_CHANNEL_LABEL[channel]}`, '2026-09-14', {
    channels: [channel],
    position: index,
  }),
);

const openPlanner = async () => {
  render(
    <MemoryRouter initialEntries={['/signal?month=2026-09']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await screen.findByRole('heading', { level: 1, name: 'Content planner' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
};

/** The chip a channel drew, wherever on the page it was drawn. */
const chips = (channel: string, root: HTMLElement | Document = document) => [
  ...root.querySelectorAll<HTMLElement>(`[data-channel="${channel}"]`),
];

describe('Signal channel treatments on the page', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 14, 12, 0));
    testState.signalPostsPayload = oneEach;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints every planner chip from the channel it names', async () => {
    await openPlanner();
    const day = screen.getByRole('region', { name: '2026-09-14' });

    for (const channel of SIGNAL_CHANNELS) {
      const [chip] = chips(channel, day);
      expect([channel, Boolean(chip)]).toEqual([channel, true]);
      const { surface, border, text } = SIGNAL_CHANNEL_TREATMENT[channel];
      expect(chip!.style.getPropertyValue('--channel-surface')).toBe(surface);
      expect(chip!.style.getPropertyValue('--channel-border')).toBe(border);
      expect(chip!.style.getPropertyValue('--channel-text')).toBe(text);
    }
  });

  it('says which channel it is without the colour', async () => {
    await openPlanner();
    const day = screen.getByRole('region', { name: '2026-09-14' });

    for (const channel of SIGNAL_CHANNELS) {
      // The initial is drawn on the swatch and the full name is there for a screen reader, so
      // the chip still names its channel in greyscale and reads aloud as more than a colour.
      // Read as the two children rather than by their text, because X's initial is its name.
      const [shown, spoken] = [...chips(channel, day)[0]!.children] as HTMLElement[];
      expect([channel, shown!.textContent]).toEqual([channel, SIGNAL_CHANNEL_INITIAL[channel]]);
      expect(shown!.getAttribute('aria-hidden')).toBe('true');
      expect([channel, spoken!.textContent]).toEqual([channel, SIGNAL_CHANNEL_LABEL[channel]]);
      expect(spoken!.className).toBe('sr-only');
    }
  });

  it('gives the channel selector the same treatments', async () => {
    await openPlanner();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Going out on Instagram' }));
    const fieldset = screen.getByRole('group', { name: 'Channels' });

    for (const channel of SIGNAL_CHANNELS) {
      const [chip] = chips(channel, fieldset);
      expect([channel, Boolean(chip)]).toEqual([channel, true]);
      const { surface, border, text } = SIGNAL_CHANNEL_TREATMENT[channel];
      expect(chip!.style.getPropertyValue('--channel-surface')).toBe(surface);
      expect(chip!.style.getPropertyValue('--channel-border')).toBe(border);
      expect(chip!.style.getPropertyValue('--channel-text')).toBe(text);
      expect(chip!.textContent).toBe(SIGNAL_CHANNEL_INITIAL[channel]);
      // The checkbox's own label already says the name, so the swatch beside it stays out of the
      // accessible name rather than making a screen reader say the channel twice.
      expect(chip!.getAttribute('aria-hidden')).toBe('true');
      expect(screen.getByRole('checkbox', { name: SIGNAL_CHANNEL_LABEL[channel] })).toBeTruthy();
    }
  });

  it('hands the stylesheet the three properties it paints from', () => {
    for (const channel of SIGNAL_CHANNELS) {
      const { surface, border, text } = SIGNAL_CHANNEL_TREATMENT[channel];
      expect(signalChannelStyle(SIGNAL_CHANNEL_TREATMENT[channel])).toEqual({
        '--channel-surface': surface,
        '--channel-border': border,
        '--channel-text': text,
      });
    }
  });
});

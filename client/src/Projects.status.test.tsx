import {
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  type Project,
  project,
  testState,
} from './App.test-setup';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_PRESENTATION,
  projectStatusStyle,
} from './components/project-status';
import { contrastRatio, meetsAaText } from '../../shared/contrast';

/** One project per status, so every assertion below reads a mixed grid rather than one tile. */
const mixedGrid: Project[] = PROJECT_STATUSES.map((status, index) =>
  project(`status-${status.toLowerCase()}`, `Project ${status}`, status, {
    lastActivityAt: `2026-03-0${index + 1}T00:00:00.000Z`,
  }),
);

const renderGrid = async () => {
  testState.projectsPayload = mixedGrid;
  render(
    <MemoryRouter initialEntries={['/projects']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
};

const tile = (status: (typeof PROJECT_STATUSES)[number]) =>
  document.querySelector<HTMLElement>(`article.project-tile[data-status="${status}"]`)!;

describe('project status on a tile', () => {
  it('gives every status its own chip, tile tint, and edge', async () => {
    await renderGrid();

    for (const status of PROJECT_STATUSES) {
      const { label, ink, surface, wash } = PROJECT_STATUS_PRESENTATION[status];
      const article = tile(status);
      expect(article).toBeTruthy();
      // The tile is painted from the same entry as the chip inside it.
      expect(article.style.getPropertyValue('--status-ink')).toBe(ink);
      expect(article.style.getPropertyValue('--status-wash')).toBe(wash);

      const chip = article.querySelector<HTMLElement>('.status-label')!;
      expect(chip.dataset.status).toBe(status);
      expect(chip.textContent).toBe(label);
      expect(chip.style.getPropertyValue('--status-surface')).toBe(surface);
      expect(chip.style.getPropertyValue('--status-ink')).toBe(ink);
    }
  });

  it('separates the five with colour removed', async () => {
    await renderGrid();

    // The word and the icon are the two channels a greyscale screenshot keeps. Both have to
    // differ across all five, or two statuses collapse into one the moment the hue is gone.
    const words = PROJECT_STATUSES.map((status) => tile(status).querySelector('.status-label')!);
    expect(new Set(words.map((chip) => chip.textContent)).size).toBe(PROJECT_STATUSES.length);
    const icons = words.map((chip) => chip.querySelector('svg')!.getAttribute('class'));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(PROJECT_STATUSES.length);
  });

  it('keeps archived recessive without dimming it below the others', async () => {
    await renderGrid();

    const archived = PROJECT_STATUS_PRESENTATION.ARCHIVED;
    // Recessive by being the one neutral in the set: no channel of its ink stands out, while
    // every other status carries a hue.
    const channels = (hex: string) =>
      [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    const spread = (hex: string) => Math.max(...channels(hex)) - Math.min(...channels(hex));
    expect(spread(archived.ink)).toBeLessThan(12);
    for (const status of PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED'))
      expect(spread(PROJECT_STATUS_PRESENTATION[status].ink)).toBeGreaterThan(30);

    // Emphasis, not legibility: the archived chip is no fainter against its own tile than the
    // quietest of the other four is against theirs.
    const others = PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED').map((status) => {
      const { ink, wash } = PROJECT_STATUS_PRESENTATION[status];
      return contrastRatio(ink, wash);
    });
    expect(contrastRatio(archived.ink, archived.wash)).toBeGreaterThanOrEqual(
      Math.min(...others) - 0.5,
    );
  });
});

describe('project status contrast', () => {
  // Everything the page paints inside a project tile. The tile is no longer white, so each of
  // these now sits on a status wash and has to clear AA there too.
  const TILE_TEXT = {
    '--ink': '#202522',
    '--muted': '#6e746f',
    '--blue': '#315f79',
    '--red': '#b9473f',
  };

  it('clears AA in both contexts, for all five statuses', () => {
    for (const status of PROJECT_STATUSES) {
      const { ink, surface, wash } = PROJECT_STATUS_PRESENTATION[status];
      // Context one: the chip, where the status word is ink on its own fill.
      expect([status, meetsAaText(ink, surface)]).toEqual([status, true]);
      // Context two: the tile, where the same ink draws the edge and every body colour the
      // page uses now sits on the tint derived from that fill.
      expect([status, meetsAaText(ink, wash)]).toEqual([status, true]);
      for (const [name, colour] of Object.entries(TILE_TEXT))
        expect([status, name, meetsAaText(colour, wash)]).toEqual([status, name, true]);
    }
  });

  it('hands the stylesheet the palette it was measured on', () => {
    for (const status of PROJECT_STATUSES) {
      const { ink, surface, wash } = PROJECT_STATUS_PRESENTATION[status];
      expect(projectStatusStyle(status)).toEqual({
        '--status-ink': ink,
        '--status-surface': surface,
        '--status-wash': wash,
      });
    }
  });
});

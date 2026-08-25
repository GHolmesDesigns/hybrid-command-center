import {
  render,
  screen,
  waitFor,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
  App,
  requests,
} from './App.test-setup';

/**
 * Settings is two independent card stacks, not six cards in a shared two-column grid. jsdom
 * cannot see the gap that motivated the change — there is no layout engine here, so the
 * measuring is `e2e/settings-column-independence.spec.ts`'s job. What this file guards is the
 * structure that gap-free layout rests on, and the part of it a browser cannot check for free:
 * that each card belongs to one column's flow, and that the document order the keyboard and a
 * screen reader follow is the intended reading order rather than whatever the old grid
 * happened to produce.
 */
describe('the Settings layout', () => {
  const renderSettings = async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/api/settings/drive'))).toBe(true),
    );
  };
  const columns = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.settings-layout > .settings-column'));
  const headingsIn = (root: ParentNode) =>
    Array.from(root.querySelectorAll('.settings-card > .section-title h2')).map((h) =>
      h.textContent?.trim(),
    );

  afterEach(() => vi.restoreAllMocks());

  it('puts every card inside one of two column stacks', async () => {
    await renderSettings();

    expect(columns()).toHaveLength(2);
    // A card left as a direct child of the grid is a card back in a shared row track, taking
    // its starting edge from whatever sits beside it. There is no such card.
    expect(document.querySelectorAll('.settings-layout > .settings-card')).toHaveLength(0);
    expect(document.querySelectorAll('.settings-layout .settings-card')).toHaveLength(8);
  });

  it('reads in one order: what the workspace connects to and organises by, then how it looks', async () => {
    await renderSettings();

    const [connections, appearance] = columns();
    expect(headingsIn(connections)).toEqual([
      'Google Drive',
      'Project categories',
      'Task tags',
      'Signal campaigns',
    ]);
    expect(headingsIn(appearance)).toEqual([
      'Branding',
      'Default views',
      'Local timezone',
      'Calendar',
    ]);

    // One reading order, and it is the document's. Nothing reorders these in CSS, so this is
    // also the order the cards appear in at both widths, and the order the keyboard walks:
    // below 1100px the two stacks sit one under the other and the eight cards read straight
    // through. `e2e/settings-column-independence.spec.ts` measures that they really do.
    expect(headingsIn(document.querySelector('.settings-layout')!)).toEqual([
      'Google Drive',
      'Project categories',
      'Task tags',
      'Signal campaigns',
      'Branding',
      'Default views',
      'Local timezone',
      'Calendar',
    ]);
  });
});

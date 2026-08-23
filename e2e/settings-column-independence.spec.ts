import { test, expect, type Page } from '@playwright/test';
import { layoutSettled } from './ready';

/**
 * The Wave 6 spec for C56. Settings used to be six cards in a two-column grid, and two cards
 * sharing a row share a starting edge: whichever of the pair was taller decided where the next
 * card on the *other* side began, so connecting Drive, a validation message appearing, or a
 * category list wrapping left a blank strip above the card beside it. C32 stopped the cards
 * stretching to fill a row they did not need; the row track itself was still shared.
 *
 * Nothing in jsdom can see this — `client/src/Settings.layout.test.tsx` guards the structure and
 * the reading order, and stops there, because a starting edge is a measurement and only a browser
 * has one. So the assertions here are all distances:
 *
 *   - Every card begins exactly one gap below the card above it **in its own column**. A card
 *     pushed down by the other column reads as a larger distance, which is the bug, in pixels.
 *   - Growing and shrinking one column moves that column's later cards by exactly as much, and
 *     moves the neighbouring column by nothing.
 *   - At one column the two stacks meet at the same gap they use internally, so the six cards
 *     read as one stack, in document order.
 *
 * The connected Drive state is faked at the HTTP boundary with `page.route`, as it is in
 * `settings-card-height.spec.ts` — this suite has no Google credentials, and the question is what
 * the layout does with a card that grew, not how it earned the extra content. Real Drive is never
 * contacted.
 */

/** `.settings-layout`'s gap, and `.settings-column`'s, in `client/src/styles.css`. */
const GAP = 18;

/** The cards in document order, which is the order they are meant to be read in. */
const READING_ORDER = [
  'Google Drive',
  'Project categories',
  'Task tags',
  'Signal campaigns',
  'Branding',
  'Local timezone',
  'Calendar',
];

type CardBox = {
  heading: string;
  column: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
};

/**
 * Each card's heading, the column stack it belongs to, and its box in document coordinates.
 * Raw numbers rather than rounded ones: fractional track widths make a card's own edges
 * fractional, and it is the *differences* between them that have to land on whole pixels.
 */
const cardBoxes = (page: Page): Promise<CardBox[]> =>
  page.evaluate(() => {
    const columns = Array.from(document.querySelectorAll('.settings-layout > .settings-column'));
    return Array.from(document.querySelectorAll('.settings-layout .settings-card')).map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        heading: card.querySelector('h2')?.textContent?.trim() ?? '',
        column: columns.findIndex((column) => column.contains(card)),
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        right: rect.right + window.scrollX,
        height: rect.height,
      };
    });
  });

const openSettings = async (page: Page) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.locator('.settings-layout .settings-card')).toHaveCount(7);
  // Every measurement below is taken across two separate renders and compared to the pixel, so the
  // two have to be laid out in the same font. `client/src/styles.css` fetches DM Sans and Manrope
  // with `display=swap`, which means one render can be measured in the fallback face and its
  // partner in the real one — about a line's worth of difference in a small font, which is the size
  // of the gap this spec failed by on CI. Waiting here rather than at each call site keeps the two
  // comparable by construction, and leaves the assertions exact.
  await layoutSettled(page);
};

/** The Drive card as it looks connected, with a root folder set: several controls taller. */
const serveConnectedDrive = (page: Page) =>
  page.route('**/api/settings/drive', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        connected: true,
        rootFolderId: 'e2e-root-folder-id',
        rootFolderUrl: 'https://drive.google.com/drive/folders/e2e-root-folder-id',
      }),
    }),
  );

const find = (boxes: CardBox[], heading: string) => {
  const box = boxes.find((candidate) => candidate.heading === heading);
  if (!box) throw new Error(`no Settings card headed "${heading}"`);
  return box;
};

test('each Settings column stacks on its own at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const cards = await cardBoxes(page);
  expect(cards.map((card) => card.heading)).toEqual(READING_ORDER);
  // Four cards in the left stack and three in the right, and every card in one — a card left as
  // the grid's own child would report column -1 and be back in a shared row track.
  expect(cards.map((card) => card.column)).toEqual([0, 0, 0, 0, 1, 1, 1]);

  const [left, right] = [0, 1].map((column) => cards.filter((card) => card.column === column));

  // The stacks are side by side and both start at the top of the layout. Independence is not
  // one stack sliding down past the other.
  expect(Math.max(...left.map((card) => card.right))).toBeLessThanOrEqual(
    Math.min(...right.map((card) => card.left)),
  );
  expect(Math.round(right[0].top - left[0].top)).toBe(0);

  // The measurement this card exists for. Each card begins one gap below the card above it in
  // its own stack — never below something in the other stack. Any card whose start was set by
  // its neighbour reads as a distance larger than the gap, by exactly the size of the blank
  // strip that used to be there.
  for (const stack of [left, right]) {
    for (let index = 1; index < stack.length; index++) {
      expect(Math.round(stack[index].top - stack[index - 1].bottom)).toBe(GAP);
    }
  }
});

test('a Settings card follows its own column, and no card follows the other one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // Connected, with the root-folder form and the disconnect control in the Drive card.
  await serveConnectedDrive(page);
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Disconnect Google Drive' })).toBeVisible();
  const connected = await cardBoxes(page);

  // The same card a few hundred pixels shorter: no credentials, so nothing but the warning and
  // a disabled button. The content above the rest of the left stack has shrunk.
  await page.unroute('**/api/settings/drive');
  await openSettings(page);
  await expect(page.getByText('Credentials required')).toBeVisible();
  const disconnected = await cardBoxes(page);

  const shrankBy =
    find(connected, 'Google Drive').height - find(disconnected, 'Google Drive').height;
  expect(Math.round(shrankBy)).toBeGreaterThan(0);

  // Every later card in the Drive card's own column moved up by exactly what it lost. Not
  // "moved up somewhat": the whole point is that the distance is the content's and nothing
  // else's, so any other number means something is still setting these starting edges.
  for (const heading of ['Project categories', 'Task tags', 'Signal campaigns']) {
    expect(Math.round(find(connected, heading).top - find(disconnected, heading).top)).toBe(
      Math.round(shrankBy),
    );
  }

  // And the neighbouring column did not move at all. This is what leaves no gap: Branding's
  // start has nothing to do with how tall Drive is, in either state.
  for (const heading of ['Branding', 'Local timezone', 'Calendar']) {
    expect(Math.round(find(disconnected, heading).top - find(connected, heading).top)).toBe(0);
  }
});

test('below 1100px the two Settings stacks read as one, in document order', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openSettings(page);
  await expect(page.locator('.settings-layout')).toHaveCSS('grid-template-columns', /^[\d.]+px$/);

  const cards = await cardBoxes(page);

  // One reading order, and it is the document's: the order down the page is the order in the
  // markup, which is also the order a screen reader announces and the keyboard walks. Nothing
  // is reordered in CSS, and this is the assertion that would fail if it ever were.
  expect([...cards].sort((a, b) => a.top - b.top).map((card) => card.heading)).toEqual(
    cards.map((card) => card.heading),
  );
  expect(cards.map((card) => card.heading)).toEqual(READING_ORDER);

  // Every card shares one left edge, and the seam between the two stacks uses the same gap the
  // stacks use inside themselves, so nothing marks where one ends and the other begins.
  expect(new Set(cards.map((card) => Math.round(card.left))).size).toBe(1);
  for (let index = 1; index < cards.length; index++) {
    expect(Math.round(cards[index].top - cards[index - 1].bottom)).toBe(GAP);
  }
});

test('the keyboard reaches the Settings cards in the order they are read', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  // Every control the layout offers, in document order, tagged so the walk below can say which
  // card the focus landed in. Disabled and hidden controls are left out because the browser
  // will not stop on them — the Drive card has only a disabled Connect button until credentials
  // exist, and the logo alt field is disabled until an address is set, so a card contributing
  // no stop is normal and expected.
  const controls = await page.evaluate(() => {
    const focusable =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    // Queried from the layout rather than the document: a comma-separated list only takes a
    // prefix on its first selector, so a document-wide query would collect the sidebar too.
    const layout = document.querySelector('.settings-layout')!;
    const cards = Array.from(layout.querySelectorAll('.settings-card'));
    return Array.from(layout.querySelectorAll<HTMLElement>(focusable))
      .filter((element) => element.offsetParent !== null)
      .map((element, index) => {
        element.dataset.tabProbe = String(index);
        return { probe: index, card: cards.findIndex((card) => card.contains(element)) };
      });
  });
  expect(controls.length).toBeGreaterThan(0);
  // Every control belongs to a card. Nothing focusable sits loose in the layout.
  expect(controls.every((control) => control.card >= 0)).toBe(true);

  const cardOf = new Map(controls.map((control) => [control.probe, control.card]));
  await page.locator('[data-tab-probe="0"]').focus();
  const visited = [cardOf.get(0)!];
  // One Tab per remaining control, with a little slack: a stop the query did not predict is
  // not a failure here, it just does not tell us which card we are in. Focus leaving the
  // layout ends the walk.
  for (let step = 1; step < controls.length + 6; step++) {
    await page.keyboard.press('Tab');
    const probe = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active?.closest('.settings-layout')) return null;
      return active.dataset.tabProbe ? Number(active.dataset.tabProbe) : -1;
    });
    if (probe === null) break;
    if (probe >= 0) visited.push(cardOf.get(probe)!);
  }

  // Tab never goes back to a card it has already left, and it visits every card that has a
  // control, in reading order. That is the same order as the visual one, checked above.
  expect(visited).toEqual([...visited].sort((a, b) => a - b));
  expect([...new Set(visited)]).toEqual([...new Set(controls.map((control) => control.card))]);
});

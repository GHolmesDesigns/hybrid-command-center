import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * The Wave 6 spec for C57. A project's blocks — its categories, its progress, its actions — used
 * to be spaced by a margin on each block rather than by one gap on the column holding them, and
 * the category list carried a top margin and nothing below it. So the distance under the
 * categories was whatever the block after them brought, which was nothing, and taking the list
 * away handed the job to the previous block's margin instead: a different number in the same
 * place, on the tile and on Project Detail both.
 *
 * Nothing in jsdom can see this. `client/src/Projects.spacing.test.tsx` and
 * `client/src/ProjectDetail.spacing.test.tsx` guard the structure the one gap rests on and stop
 * there, because a gap is a measurement and only a browser has one. So the assertions here are
 * all distances:
 *
 *   - Every block begins exactly one gap below the block above it, on the tile and in the
 *     overview. A block spacing itself reads as some other number, which is the bug in pixels.
 *   - The same walk holds with no categories, with one, and with six wrapped over more than one
 *     line — and the spec checks the six really did wrap rather than assuming it.
 *   - It holds for a short description and a long one, and for a project with no tasks and one
 *     whose tasks are all done.
 *   - No block brings a vertical margin of its own and none is positioned, so nothing here can
 *     be reading a height to place itself.
 *
 * Every name is stamped with the run and every query is scoped to the projects this spec
 * created, because the suite shares one database.
 */

/** `.project-tile`'s gap, and `.project-overview`'s, in `client/src/styles.css`. */
const GAP = 14;

type Block = {
  name: string;
  top: number;
  bottom: number;
  marginTop: string;
  marginBottom: string;
  position: string;
};

/**
 * The blocks of one column, in document order, with the box each occupies, the vertical margins
 * it brings, and whether it is positioned. Raw numbers rather than rounded ones: fractional grid
 * tracks make a block's own edges fractional, and it is the *differences* between them that have
 * to land on whole pixels.
 */
const blocksIn = (column: Locator): Promise<Block[]> =>
  column.evaluate((node) =>
    Array.from(node.children).map((child) => {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return {
        name: child.tagName === 'A' ? 'link' : child.className.split(' ')[0],
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        position: style.position,
      };
    }),
  );

/** How many lines of chips the column's category list occupies, and 0 if it has none. */
const categoryLines = (column: Locator): Promise<number> =>
  column.evaluate((node) => {
    const list = node.querySelector(':scope > .tag-list');
    if (!list) return 0;
    return new Set(
      Array.from(list.children).map((chip) => Math.round(chip.getBoundingClientRect().top)),
    ).size;
  });

/**
 * One gap between every pair of blocks, no block bringing a margin of its own, and none of them
 * positioned. `auto` margins resolve to the space they claimed, so a block pushed to the bottom
 * of its column reads here as a number rather than as zero.
 */
const expectOneGap = (blocks: Block[]) => {
  expect(blocks.length).toBeGreaterThan(1);
  for (let index = 1; index < blocks.length; index++)
    expect(
      Math.round(blocks[index].top - blocks[index - 1].bottom),
      `${blocks[index - 1].name} → ${blocks[index].name}`,
    ).toBe(GAP);
  for (const block of blocks) {
    expect(block.marginTop, `margin-top of ${block.name}`).toBe('0px');
    expect(block.marginBottom, `margin-bottom of ${block.name}`).toBe('0px');
    expect(block.position, `position of ${block.name}`).toBe('static');
  }
};

/** The tile for `name`, scoped so the grid's other projects cannot answer for it. */
const tileFor = (page: Page, name: string) =>
  page
    .locator('article.project-tile')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

test('a project tile spaces its blocks the same way at every category count', async ({ page }) => {
  const run = Date.now(),
    // Long enough that six of them wrap a tile three to a row several times over.
    label = (index: number) => `E2E spacing label ${index} of six ${run}`,
    name = (slug: string) => `E2E spacing ${slug} ${run}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: `E2E Spacing Client ${run}` } })
  ).json();
  const newProject = async (slug: string, data: Record<string, unknown> = {}) =>
    (
      await page.request.post('/api/projects', {
        data: { clientId: client.id, name: name(slug), ...data },
      })
    ).json();

  // Six categories on one project, one on the next, none on the third — the three states the
  // one gap has to survive. Two of them also carry the descriptions and the task counts the
  // card names, so no tile is varying in only one way.
  const categories: { id: string }[] = [];
  for (let index = 0; index < 6; index++)
    categories.push(
      await (await page.request.post('/api/categories', { data: { name: label(index) } })).json(),
    );
  const wrapped = await newProject('six', {
    description:
      'A description long enough to run past a single line in a tile three to a row, so the block above the categories is taller here than on either tile beside it.',
  });
  const single = await newProject('one');
  await newProject('none', { description: 'Short.' });
  for (const category of categories)
    await page.request.post(`/api/projects/${wrapped.id}/categories`, {
      data: { categoryId: category.id },
    });
  await page.request.post(`/api/projects/${single.id}/categories`, {
    data: { categoryId: categories[0].id },
  });

  // Four tasks on the wrapped tile, all completed, so its progress bar is full and its task
  // health line is the longest of the three; no tasks at all on the tile with no categories.
  for (const title of ['One', 'Two', 'Three', 'Four']) {
    const created = await (
      await page.request.post('/api/tasks', {
        data: { projectId: wrapped.id, title: `E2E spacing task ${title} ${run}` },
      })
    ).json();
    await page.request.patch(`/api/tasks/${created.id}`, {
      data: { status: 'COMPLETE', revision: created.revision },
    });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/projects');
  const tiles = ['six', 'one', 'none'].map((slug) => tileFor(page, name(slug)));
  for (const tile of tiles) await expect(tile).toHaveCount(1);
  const [six, one, none] = [
    await blocksIn(tiles[0]),
    await blocksIn(tiles[1]),
    await blocksIn(tiles[2]),
  ];

  // The list really is on more than one line, so the wrapping case is measured rather than
  // assumed. That is the state the gap below the categories used to vanish under.
  expect(await categoryLines(tiles[0])).toBeGreaterThan(1);
  expect(await categoryLines(tiles[1])).toBe(1);
  expect(await categoryLines(tiles[2])).toBe(0);
  await expect(tiles[0].locator('.progress')).toContainText('4/4');
  await expect(tiles[2].locator('.progress')).toContainText('0/0');

  // The measurement this card exists for. Six categories over several lines, one category, and
  // no category list at all: the same distance between every pair of blocks in all three,
  // whatever the description above them and whatever the task count below.
  for (const blocks of [six, one, none]) expectOneGap(blocks);
  expect(six.map((block) => block.name)).toEqual([
    'project-card-head',
    'link',
    'tag-list',
    'progress',
    'project-meta',
    'card-actions',
    'keyboard-move',
  ]);
  expect(one.map((block) => block.name)).toEqual(six.map((block) => block.name));
  // Nothing takes the absent list's place: one block fewer, and the block that followed it
  // follows what came before it at the same distance.
  expect(none.map((block) => block.name)).toEqual(
    six.map((block) => block.name).filter((block) => block !== 'tag-list'),
  );
});

test('Project Detail spaces its overview the same way at every category count', async ({
  page,
}) => {
  const run = Date.now(),
    // Long enough that six of them wrap the list at full page width.
    label = (index: number) => `E2E detail spacing label number ${index} of six ${run}`;

  const client = await (
    await page.request.post('/api/clients', { data: { name: `E2E Detail Spacing ${run}` } })
  ).json();
  const categories: { id: string }[] = [];
  for (let index = 0; index < 6; index++)
    categories.push(
      await (await page.request.post('/api/categories', { data: { name: label(index) } })).json(),
    );
  const labelled = await (
    await page.request.post('/api/projects', {
      data: {
        clientId: client.id,
        name: `E2E detail spacing labelled ${run}`,
        description:
          'A description long enough to wrap the page head above the overview onto a second line, which is what used to decide how much room the categories were given.',
      },
    })
  ).json();
  const bare = await (
    await page.request.post('/api/projects', {
      data: { clientId: client.id, name: `E2E detail spacing bare ${run}` },
    })
  ).json();
  for (const category of categories)
    await page.request.post(`/api/projects/${labelled.id}/categories`, {
      data: { categoryId: category.id },
    });

  await page.setViewportSize({ width: 1440, height: 900 });
  const overview = page.locator('.project-overview');
  const openProject = async (project: { id: string; name: string }) => {
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: project.name })).toBeVisible();
    await expect(overview).toHaveCount(1);
  };

  await openProject(labelled);
  const withCategories = await blocksIn(overview);
  expect(withCategories.map((block) => block.name)).toEqual([
    'project-summary',
    'tag-list',
    'detail-actions',
    'field-hint',
  ]);
  // Wrapped, which is the state the actions used to sit flush against.
  expect(await categoryLines(overview)).toBeGreaterThan(1);
  expectOneGap(withCategories);

  // One category rather than six: one line of chips, and the same distance under it.
  for (const category of categories.slice(1))
    await page.request.delete(`/api/projects/${labelled.id}/categories/${category.id}`);
  await page.reload();
  await expect(page.locator('.project-overview > .tag-list')).toHaveCount(1);
  expect(await categoryLines(overview)).toBe(1);
  expectOneGap(await blocksIn(overview));

  // And a project with no categories at all, where the gap used to come from the summary's own
  // margin instead. The actions follow at the distance the list would have been followed at.
  await openProject(bare);
  const withoutCategories = await blocksIn(overview);
  expect(withoutCategories.map((block) => block.name)).toEqual([
    'project-summary',
    'detail-actions',
    'field-hint',
  ]);
  expectOneGap(withoutCategories);

  // Narrow enough to wrap the summary and the actions themselves. The column is still the
  // column: nothing in it was holding a size that only the wide layout had.
  await page.setViewportSize({ width: 700, height: 900 });
  await openProject(labelled);
  expectOneGap(await blocksIn(overview));
});

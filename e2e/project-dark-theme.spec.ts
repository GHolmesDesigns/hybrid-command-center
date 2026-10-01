import { expect, test } from '@playwright/test';
import { contrastRatio } from '../shared/contrast';
import { gotoSettled } from './ready';

const rgbHex = (color: string) => {
  const channels = color
    .match(/\d+/g)
    ?.slice(0, 3)
    .map((channel) => Number(channel));
  if (!channels || channels.length !== 3) throw new Error(`Unexpected RGB color: ${color}`);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
};

test('Projects cards retain dark surfaces and readable text in grid and list views', async ({
  page,
}) => {
  const run = Date.now();
  const client = await (
    await page.request.post('/api/clients', { data: { name: `E2E Dark Project Client ${run}` } })
  ).json();
  const projectName = `E2E Dark Project ${run}`;
  await page.request.post('/api/projects', {
    data: {
      clientId: client.id,
      name: projectName,
      description: `Description for ${projectName}`,
      status: 'ACTIVE',
    },
  });
  await page.addInitScript(() => localStorage.setItem('hcc-theme-mode', 'dark'));

  for (const [view, cardSelector, titleSelector, bodySelector] of [
    ['grid', '.project-tile', 'h2', 'p'],
    ['list', '.project-row', '.project-row-link strong', '.project-row-meta'],
  ] as const) {
    await gotoSettled(page, `/projects?view=${view}&visibility=all`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const card = page.locator(cardSelector).filter({ hasText: projectName });
    await expect(card).toBeVisible();

    const colors = await card.evaluate(
      (element, selectors) => ({
        background: getComputedStyle(element).backgroundColor,
        title: getComputedStyle(element.querySelector(selectors.title)!).color,
        body: getComputedStyle(element.querySelector(selectors.body)!).color,
      }),
      { title: titleSelector, body: bodySelector },
    );
    expect(colors.background).not.toBe('rgb(255, 255, 255)');
    expect(contrastRatio(rgbHex(colors.title), rgbHex(colors.background))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(rgbHex(colors.body), rgbHex(colors.background))).toBeGreaterThanOrEqual(
      4.5,
    );
  }
});

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * When a page is ready to be clicked or measured — which is later than when it says it has loaded.
 *
 * ## Why waiting on a heading is not enough
 *
 * Every spec here opens a page and then waits for its `<h1>`. That is the earliest thing to render
 * and the weakest possible proof the page is usable: the heading is present long before the reads
 * behind it have answered and long before the layout has stopped moving. Three separate flakes came
 * from trusting it (#251, #266, #267), each failing somewhere different downstream.
 *
 * ## The layout half, which is what this helper answers
 *
 * `client/src/styles.css` opens with
 *
 * ```css
 * @import url('https://fonts.googleapis.com/css2?family=DM+Sans:...&display=swap');
 * ```
 *
 * so a page first renders in the fallback stack and **re-lays out** when DM Sans and Manrope arrive.
 * `display=swap` is the right choice for a person — text is readable immediately — and it is exactly
 * what breaks an automated run: Playwright refuses to click an element that is still moving, and
 * `toBeVisible()` on a heading does not wait for the swap.
 *
 * That is #267. The **Import a playbook** button resolved instantly and then spent the entire
 * thirty-second timeout failing the *stable* half of visible-enabled-stable, on Windows, where the
 * font request is slowest. It is also the most likely explanation for #252, which compares two card
 * geometries to the pixel and fails by about one line of a small font.
 *
 * `document.fonts.ready` settles once every face the document uses has loaded or failed, so it
 * covers the offline case too: if the request never lands, the promise still resolves and the run
 * proceeds on the fallback rather than hanging.
 *
 * ## What this does not answer
 *
 * Whether the page's own data has arrived. That is per-page — the Import page has two independent
 * reads and the planner has its own — so it belongs in the spec, which knows what content to wait
 * for. This helper is only the half that is the same everywhere.
 *
 * It also does not make a page *stay* still. A read answering later will reflow it again, which is
 * why the data wait belongs after this one rather than instead of it.
 */
export async function layoutSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * Navigate, then wait for the layout to stop moving.
 *
 * The pairing most specs want: `page.goto` resolves on the document load event, which is before the
 * fonts have swapped. Waiting for page-specific content is still the spec's job and still comes
 * after this.
 */
export async function gotoSettled(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await layoutSettled(page);
}

/** True when the response is a successful merge preview read for any client. */
const isMergePreviewResponse = (response: {
  request: () => { method: () => string };
  url: () => string;
  ok: () => boolean;
}) =>
  response.request().method() === 'POST' &&
  response.url().includes('/merge/preview') &&
  response.ok();

/**
 * The merge dialog re-plans on a short debounce after each field choice. Confirmation is only
 * valid once the preview on screen matches those choices — wait for that pairing rather than
 * clicking through a stale plan.
 */
export async function waitForMergePreview(page: Page): Promise<void> {
  await page.waitForResponse(isMergePreviewResponse);
}

/** After the last merge choice, wait for the preview and for confirmation to be offered again. */
export async function mergeConfirmationReady(page: Page, dialog: Locator): Promise<void> {
  await waitForMergePreview(page);
  await expect(dialog.getByRole('button', { name: 'Merge clients' })).toBeEnabled();
}

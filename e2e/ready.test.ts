import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { gotoSettled, layoutSettled } from './ready.ts';

/**
 * The helper's contract without a browser: that it waits on the document's own font promise, and
 * that navigation happens before the wait rather than beside it. Playwright's `Page` is stubbed
 * because what is worth pinning here is the ordering and the thing being awaited — the real
 * behaviour of `document.fonts.ready` belongs to the browser, and the specs exercise it there.
 */
type Evaluated = () => Promise<void>;

function stubPage() {
  const calls: string[] = [];
  let evaluated: Evaluated | undefined;
  const page = {
    goto: async (path: string) => {
      calls.push(`goto ${path}`);
    },
    evaluate: async (fn: Evaluated) => {
      calls.push('evaluate');
      evaluated = fn;
    },
  } as unknown as Page;
  return { page, calls, run: () => evaluated };
}

/** Installs a `document.fonts.ready` the evaluated callback can await, and hands back its resolver. */
function stubFontsReady() {
  let settle = () => {};
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { fonts: { ready } };
  return {
    settle,
    restore: () => {
      (globalThis as { document?: unknown }).document = previous;
    },
  };
}

describe('layoutSettled', () => {
  it('evaluates in the page rather than waiting in the runner', async () => {
    const { page, calls } = stubPage();
    await layoutSettled(page);
    expect(calls).toEqual(['evaluate']);
  });

  it('waits for the document font promise and not for anything else', async () => {
    const { page, run } = stubPage();
    await layoutSettled(page);
    const fonts = stubFontsReady();
    try {
      let settled = false;
      const waiting = run()?.().then(() => {
        settled = true;
      });
      // Nothing has resolved the font promise, so the callback must still be pending.
      await Promise.resolve();
      expect(settled).toBe(false);

      fonts.settle();
      await waiting;
      expect(settled).toBe(true);
    } finally {
      fonts.restore();
    }
  });
});

describe('gotoSettled', () => {
  it('navigates first, then waits for the layout', async () => {
    const { page, calls } = stubPage();
    await gotoSettled(page, '/settings');
    // Order is the whole point: waiting before the navigation would settle the previous page.
    expect(calls).toEqual(['goto /settings', 'evaluate']);
  });
});

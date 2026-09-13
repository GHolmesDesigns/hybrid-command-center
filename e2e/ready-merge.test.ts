import { describe, expect, it, vi } from 'vitest';

const toBeEnabled = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@playwright/test', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@playwright/test')>();
  return {
    ...actual,
    expect: vi.fn(() => ({ toBeEnabled })),
  };
});

import type { Locator, Page } from '@playwright/test';
import { mergeConfirmationReady } from './ready.ts';

describe('mergeConfirmationReady', () => {
  it('waits for confirmation to be enabled after the preview has landed', async () => {
    const page = {} as unknown as Page;
    const mergeButton = {};
    const dialog = {
      getByRole: vi.fn(() => mergeButton),
    } as unknown as Locator;

    await mergeConfirmationReady(page, dialog);

    expect(dialog.getByRole).toHaveBeenCalledWith('button', { name: 'Merge clients' });
    expect(toBeEnabled).toHaveBeenCalledOnce();
  });
});

import type { Db } from '../db.ts';
import { resolveProviderAccounts } from './accounts.ts';
import type { PublishProvider, PublishTarget } from './provider.ts';
import { BufferAccountsService } from './buffer-accounts.ts';

/**
 * Every current provider account a person may choose when previewing or saving publish targets.
 *
 * Post Bridge and Buffer are read here and only here on those paths — never on an ordinary Signal
 * page load — and the result is resolved to local surrogates in one pass.
 *
 * The two providers still load in parallel so the Buffer account snapshot can be refreshed for
 * historical lifecycle reads, but only Post Bridge accounts enter a new Signal target list.
 * Buffer never falls through as a current route.
 */
export async function resolvePublishingTargets(
  db: Db,
  publishProvider: PublishProvider,
  bufferAccounts: BufferAccountsService,
  clock: () => Date,
): Promise<PublishTarget[]> {
  const loadPostBridge = async (): Promise<
    { ok: true; targets: PublishTarget[] } | { ok: false; error: unknown }
  > => {
    if (!publishProvider.available) return { ok: true, targets: [] };
    try {
      return { ok: true, targets: await publishProvider.listTargets() };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const loadBuffer = async (): Promise<PublishTarget[]> => {
    // `available` already encodes whether a usable read provider was handed in — including a test
    // mock — so the env key is not checked again here. Refresh itself no-ops cleanly when the
    // provider is unavailable and swallows remote failures without replacing the prior generation.
    if (!bufferAccounts.available) return [];
    await bufferAccounts.refresh();
    return bufferAccounts.selectableTargets();
  };

  const [postBridge] = await Promise.all([loadPostBridge(), loadBuffer()]);
  if (!postBridge.ok) {
    // Buffer accounts on this press never become a fallback: C155/#447 assigns every current
    // Signal route to Post Bridge. Its failure must remain visible and current targets refuse.
    throw postBridge.error;
  }

  return resolveProviderAccounts(db, postBridge.targets, clock);
}

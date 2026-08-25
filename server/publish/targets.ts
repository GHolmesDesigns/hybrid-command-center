import type { Db } from '../db.ts';
import { resolveProviderAccounts } from './accounts.ts';
import type { PublishProvider, PublishTarget } from './provider.ts';
import { BufferAccountsService } from './buffer-accounts.ts';

/**
 * Every provider account a person may choose when previewing or saving publish targets.
 *
 * Post Bridge and Buffer are read here and only here on those paths — never on an ordinary Signal
 * page load — and the result is resolved to local surrogates in one pass.
 *
 * The two providers load in parallel and fail independently. A cold Post Bridge listing must not
 * block or abort a Buffer refresh on the same press, and a Buffer refresh that leaves the prior
 * generation in place must not erase Post Bridge accounts already listed. Neither side falls
 * through to the other: each contributes only its own accounts.
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

  const [postBridge, bufferTargets] = await Promise.all([loadPostBridge(), loadBuffer()]);
  if (!postBridge.ok) {
    // Buffer accounts on this press mean Post Bridge's failure is not Buffer's problem — leave Post
    // Bridge empty so its channels refuse in the plan, and keep the Buffer rows. With nothing from
    // either side, the Post Bridge error is the only honest answer and must stay visible.
    if (bufferTargets.length === 0) throw postBridge.error;
  }

  return resolveProviderAccounts(
    db,
    [...(postBridge.ok ? postBridge.targets : []), ...bufferTargets],
    clock,
  );
}

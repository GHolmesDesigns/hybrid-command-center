import type { Db } from '../db.ts';
import { bufferConfigured } from '../config.ts';
import { resolveProviderAccounts } from './accounts.ts';
import type { PublishProvider, PublishTarget } from './provider.ts';
import { BufferAccountsService } from './buffer-accounts.ts';

/**
 * Every provider account a person may choose when previewing or saving publish targets.
 *
 * Post Bridge and Buffer are read here and only here on those paths — never on an ordinary Signal
 * page load — and the result is resolved to local surrogates in one pass.
 */
export async function resolvePublishingTargets(
  db: Db,
  publishProvider: PublishProvider,
  bufferAccounts: BufferAccountsService,
  clock: () => Date,
): Promise<PublishTarget[]> {
  const listed: PublishTarget[] = [];
  if (publishProvider.available) listed.push(...(await publishProvider.listTargets()));
  if (bufferConfigured() && bufferAccounts.available) {
    await bufferAccounts.refresh();
    listed.push(...bufferAccounts.selectableTargets());
  }
  return resolveProviderAccounts(db, listed, clock);
}

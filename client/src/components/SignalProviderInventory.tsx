import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Eye, PackageSearch, RefreshCw } from 'lucide-react';
import { api, send } from '../api';
import {
  providerInventoryPostName,
  type ProviderInventoryEntry,
  type ProviderInventorySnapshot,
} from '../../../shared/provider-inventory';
import { PROVIDER_POST_STATE_LABEL } from '../../../shared/publish';
import { SIGNAL_CHANNEL_LABEL } from '../../../shared/signal';
import { Empty } from './Primitives';

/**
 * What Post Bridge is holding, including the posts this app did not make.
 *
 * ## Read-only, and it says so
 *
 * Nothing in this panel writes anything. There is one button and it asks the server to read the
 * provider again; every other control is a link out. Adopting, importing, editing, rescheduling, and
 * withdrawing one of these posts are all declined in §0.3 of
 * `docs/post-bridge-integrations-plan.md`, so no such control exists to be greyed out — and the
 * panel states the limit in words rather than leaving somebody to discover it by looking for a
 * button.
 *
 * ## Refreshed only when somebody presses refresh
 *
 * Mounting this panel reads stored rows and contacts no provider, which is what makes it safe to
 * have open beside the planner. The refresh is the only path to Post Bridge, and a failed one leaves
 * the previous inventory on screen with the reason above it: an inventory that vanished because a
 * read failed would hide exactly the collision this panel exists to surface.
 *
 * ## Every judgement comes from the shared rules
 *
 * Which rows are orphans, how a caption is shortened, and what a state is called are all decided in
 * `shared/provider-inventory.ts` and `shared/publish.ts` on the server's side of the read. This
 * component formats and nothing else, so the panel and the queue-health alert cannot disagree about
 * which posts this app did not send.
 */

/** An instant as the reader's own locale, or the provider's "no instant" said as words. */
const instantLabel = (instant: string | null) =>
  instant ? new Date(instant).toLocaleString() : 'No scheduled instant';

/** Accounts as handles where this workspace knows them, and as ids where it does not. */
const accountLabel = (entry: ProviderInventoryEntry) =>
  entry.accounts.length
    ? entry.accounts
        .map((account) =>
          account.handle
            ? account.channel
              ? `${account.handle} (${SIGNAL_CHANNEL_LABEL[account.channel]})`
              : account.handle
            : `Account ${account.accountId}`,
        )
        .join(', ')
    : 'No accounts named';

function Entry({ entry }: { entry: ProviderInventoryEntry }) {
  return (
    <li className={`signal-inventory-row ${entry.orphan ? 'is-orphan' : ''}`}>
      <p className="signal-inventory-head">
        {/* The origin is words and an icon, never a colour on its own (`AGENTS.md`). */}
        <span className={`signal-inventory-origin ${entry.orphan ? 'is-orphan' : ''}`}>
          {entry.orphan ? <Eye aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          {entry.orphan ? 'Not sent from here' : 'Sent from here'}
        </span>
        <span className="signal-inventory-state">{PROVIDER_POST_STATE_LABEL[entry.state]}</span>
        <strong>{providerInventoryPostName(entry)}</strong>
      </p>
      <p className="signal-inventory-detail">
        {instantLabel(entry.scheduledInstant)} · {accountLabel(entry)}
      </p>
      <p className="signal-inventory-meta">
        <span>Provider id {entry.providerPostId}</span>
        {entry.providerUrl && (
          <a href={entry.providerUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink aria-hidden="true" /> Open at the provider
          </a>
        )}
      </p>
    </li>
  );
}

export function SignalProviderInventoryPanel({ reloadKey = 0 }: { reloadKey?: number }) {
  const [snapshot, setSnapshot] = useState<ProviderInventorySnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (run: () => Promise<ProviderInventorySnapshot>) => {
    setBusy(true);
    setError('');
    try {
      setSnapshot(await run());
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(
    () => act(() => api<ProviderInventorySnapshot>('/signal/provider-inventory')),
    [act],
  );

  useEffect(() => {
    // A local read of stored rows. `reloadKey` is the planner saying a post it owns has changed,
    // which can move a row between "sent from here" and an orphan without the provider changing.
    void load();
  }, [load, reloadKey]);

  const orphans = snapshot?.counts.orphans ?? 0;
  const headline = !snapshot
    ? ''
    : !snapshot.lastRefreshAt
      ? 'Nothing has been read from the provider yet.'
      : `${snapshot.counts.posts} ${snapshot.counts.posts === 1 ? 'post' : 'posts'} at the provider, ${orphans} of them not sent from here. Read ${new Date(snapshot.lastRefreshAt).toLocaleString()}.`;

  return (
    <section className="signal-inventory" aria-labelledby="signal-inventory-title">
      <div className="signal-section-head">
        <div>
          <span className="eyebrow">Provider inventory</span>
          <h2 id="signal-inventory-title">What Post Bridge is holding</h2>
        </div>
        {snapshot?.available && (
          <button
            className="secondary"
            onClick={() =>
              void act(() =>
                send<ProviderInventorySnapshot>('/signal/provider-inventory/refresh', 'POST'),
              )
            }
            disabled={busy}
          >
            <RefreshCw className={busy ? 'spin' : ''} /> Refresh inventory
          </button>
        )}
      </div>
      {error && (
        <div className="refresh-error" role="alert">
          {error}
        </div>
      )}
      {snapshot && (
        <>
          <p className="signal-inventory-headline" aria-live="polite">
            <PackageSearch aria-hidden="true" /> {headline}
          </p>
          {/* The reason the last attempt replaced nothing, above the rows it did not replace, so a
              stale inventory is never presented as a current one. */}
          {snapshot.reason && (
            <div className="refresh-error" role="status">
              {snapshot.reason}
            </div>
          )}
          <p className="signal-inventory-note">
            This is a read of the provider, refreshed only when you press the button. Nothing here
            can adopt, edit, reschedule, or withdraw a post — a post the app did not send is listed
            so it cannot collide with a slot you think is empty, and it stays the provider's to act
            on.
          </p>
          {snapshot.entries.length === 0 ? (
            <Empty
              compact
              title={snapshot.lastRefreshAt ? 'The provider holds nothing' : 'Not read yet'}
              body={
                snapshot.available
                  ? snapshot.lastRefreshAt
                    ? 'The last complete read listed no posts at all.'
                    : 'Press Refresh inventory to read every page of what Post Bridge is holding.'
                  : 'Publishing is not configured, so there is nothing to read. Set POST_BRIDGE_API_KEY to ask the provider what it holds.'
              }
            />
          ) : (
            <ul className="signal-inventory-list">
              {snapshot.entries.map((entry) => (
                <Entry key={entry.providerPostId} entry={entry} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

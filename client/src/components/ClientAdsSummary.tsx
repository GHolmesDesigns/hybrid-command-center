import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, CircleSlash, Clock } from 'lucide-react';
import { api } from '../api';
import {
  ADS_STALE_MESSAGE,
  formatAdsCustomerId,
  type AdsPerformanceState,
} from '../../../shared/ads';
import { buildAdsPerformanceView } from '../../../shared/ads-performance-view';
import { Figures } from './AdsView';
import { formatDateTime } from './formatting';

/**
 * A compact, read-only Google Ads summary on client detail (C260).
 *
 * It reads the same stored snapshot `/ads` does, through `GET /api/ads/performance` — SQLite only, so
 * rendering this contacts no provider and writes nothing. The accounts shown are the ones the
 * snapshot already maps to this client (a client merge retargets them to the survivor, so a merged
 * client has none), and the figures are `buildAdsPerformanceView` over the whole stored window:
 * the provider's own daily values added, one total per currency, no totals rather than zeros for an
 * account set with nothing measured. Stale or disconnected state is said beside the last-good data.
 */
export function ClientAdsSummary({
  clientId,
  mergedIntoName,
}: {
  clientId: string;
  mergedIntoName?: string;
}) {
  const [state, setState] = useState<AdsPerformanceState | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let current = true;
    api<AdsPerformanceState>('/ads/performance')
      .then((next) => {
        if (!current) return;
        setState(next);
        setLoadError('');
      })
      .catch((error: Error) => {
        if (current) setLoadError(error.message);
      });
    return () => {
      current = false;
    };
  }, [clientId]);

  const view = useMemo(
    () =>
      state
        ? buildAdsPerformanceView(state, { client: clientId, account: null, from: null, to: null })
        : null,
    [state, clientId],
  );
  const rows = view?.groups.flatMap((group) => group.accounts) ?? [];
  const connected = state?.connectionStatus === 'CONNECTED';

  return (
    <section className="panel span2 client-ads-summary" aria-label="Google Ads">
      <div className="section-title">
        <div>
          <span className="eyebrow">Google Ads</span>
          <h2>Ads summary</h2>
        </div>
        {rows.length > 0 && (
          <Link className="secondary buttonlike" to={`/ads?client=${encodeURIComponent(clientId)}`}>
            Open in Ads <ChevronRight />
          </Link>
        )}
      </div>

      {!state && !loadError && (
        <p role="status" className="field-hint">
          Loading the stored Ads snapshot…
        </p>
      )}
      {loadError && (
        <p role="alert" className="ads-banner is-error">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>Could not read the Ads snapshot.</strong> {loadError}
          </span>
        </p>
      )}

      {state && rows.length === 0 && (
        <p className="ads-none">
          <CircleSlash aria-hidden="true" />{' '}
          {mergedIntoName
            ? `This client was merged into ${mergedIntoName}; Ads accounts moved with it.`
            : 'No approved Ads account is mapped to this client.'}{' '}
          {!mergedIntoName && <Link to="/settings">Map one in Settings.</Link>}
        </p>
      )}

      {state && rows.length > 0 && view && (
        <>
          {!connected && (
            <p role="status" className="ads-banner is-warning">
              <CircleSlash aria-hidden="true" />
              <span>
                <strong>Google Ads is not connected.</strong> These are the last stored figures and
                they are not being refreshed.
              </span>
            </p>
          )}
          {state.lastAttemptFailed && (
            <p role="alert" className="ads-banner is-error">
              <AlertTriangle aria-hidden="true" />
              <span>
                <strong>The latest refresh failed, so these figures are stale.</strong>{' '}
                {view.snapshotAt
                  ? `Showing the last successful snapshot, from ${formatDateTime(view.snapshotAt)}.`
                  : 'There is no earlier snapshot to show.'}
              </span>
            </p>
          )}
          <p className="field-hint">
            {view.accountCount} {view.accountCount === 1 ? 'account' : 'accounts'}, over the stored
            90 days.
            {view.snapshotAt
              ? ` Last successful snapshot: ${formatDateTime(view.snapshotAt)}.`
              : ' Not refreshed yet.'}
          </p>
          <ul className="ads-client-accounts">
            {rows.map(({ account }) => (
              <li key={account.customerId}>
                <strong>{account.descriptiveName}</strong>{' '}
                <span className="field-hint">
                  {formatAdsCustomerId(account.customerId)} · {account.currencyCode}
                  {account.syncedAt ? (
                    <>
                      {' '}
                      · <Clock aria-hidden="true" /> {formatDateTime(account.syncedAt)}
                    </>
                  ) : (
                    ' · Not refreshed yet'
                  )}
                </span>
                {account.stale && (
                  <span className="ads-banner is-warning" role="status">
                    <AlertTriangle aria-hidden="true" /> {ADS_STALE_MESSAGE[account.stale]}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {view.currencyTotals.length === 0 ? (
            <p className="ads-none">
              <CircleSlash aria-hidden="true" /> Google has reported no measured days for these
              accounts yet, so there are no totals. An empty total is not a zero.
            </p>
          ) : (
            view.currencyTotals.map((entry) => (
              <div key={entry.currencyCode} className="ads-currency">
                <h3>{entry.currencyCode}</h3>
                <Figures
                  totals={entry.totals}
                  currencyCode={entry.currencyCode}
                  label={`Totals in ${entry.currencyCode}`}
                />
              </div>
            ))
          )}
        </>
      )}
    </section>
  );
}

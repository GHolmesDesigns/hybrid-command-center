import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, RefreshCw, UserX } from 'lucide-react';
import { api, send } from '../api';
import {
  ADS_STALE_MESSAGE,
  formatAdsCustomerId,
  type AdsPerformanceState,
} from '../../../shared/ads';
import {
  ADS_CLIENT_UNASSIGNED,
  ADS_CLIENT_UNASSIGNED_LABEL,
  ADS_FIGURES,
  ADS_FIGURE_LABEL,
  ADS_FILTER_PARAMS,
  adsAccountsInScope,
  adsDateBounds,
  buildAdsPerformanceView,
  formatAdsCost,
  readAdsFilters,
  type AdsFigures,
} from '../../../shared/ads-performance-view';
import { Empty } from './Primitives';
import { PageHead } from './Shell';
import { formatDateTime } from './formatting';

/**
 * Google Ads performance (C259): what the last refresh stored, read-only.
 *
 * Opening this page, or changing a filter, reads SQLite through `GET /api/ads/performance` and
 * nothing else — no provider call, no quota, no write. The one path to Google is the **Refresh**
 * button, which a person presses; a failed refresh leaves the last-good figures on screen and says
 * so.
 *
 * The four figures are the provider's own. The only arithmetic is the addition
 * `shared/ads-performance-view.ts` performs, separately per currency; a campaign or set with no
 * measured day shows no figures rather than zeros, and no rate or cross-currency amount exists here.
 *
 * Filters (`client`, `account`, `from`, `to`) are durable URL state per
 * `docs/view-state-convention.md`, read defensively.
 */

const FILTER_NOTICE: Record<(typeof ADS_FILTER_PARAMS)[number], string> = {
  client: 'client',
  account: 'account',
  from: 'start date',
  to: 'end date',
};

export function Figures({
  totals,
  currencyCode,
  label,
}: {
  totals: AdsFigures;
  currencyCode: string;
  label: string;
}) {
  return (
    <dl className="ads-figures" aria-label={label}>
      {ADS_FIGURES.map((figure) => (
        <div className="ads-figure" key={figure}>
          <dt>{ADS_FIGURE_LABEL[figure]}</dt>
          <dd>
            {figure === 'costMicros'
              ? formatAdsCost(totals.costMicros, currencyCode)
              : totals[figure].toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AdsView({
  flash,
}: {
  flash: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [state, setState] = useState<AdsPerformanceState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [params, setParams] = useSearchParams();

  const load = useCallback(async () => {
    try {
      setState(await api<AdsPerformanceState>('/ads/performance'));
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const accounts = useMemo(() => state?.accounts ?? [], [state]);
  const { filters, ignored } = useMemo(() => readAdsFilters(params, accounts), [params, accounts]);
  const view = useMemo(
    () => (state ? buildAdsPerformanceView(state, filters) : null),
    [state, filters],
  );
  const bounds = useMemo(() => adsDateBounds(accounts), [accounts]);

  /** Writes one filter, keeps every other parameter, and omits a default so the address stays short. */
  const setFilter = (name: (typeof ADS_FILTER_PARAMS)[number], value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    // Choosing another client drops an account that is no longer inside it.
    if (name === 'client') next.delete('account');
    setParams(next);
  };
  const clearFilters = () => {
    const next = new URLSearchParams(params);
    for (const name of ADS_FILTER_PARAMS) next.delete(name);
    setParams(next);
  };

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError('');
    try {
      const response = await send<{ performance: AdsPerformanceState }>(
        '/ads/performance/refresh',
        'POST',
      );
      setState(response.performance);
      flash('Refreshed the Ads snapshot from Google. Nothing in Google Ads was changed.');
    } catch (error) {
      setRefreshError((error as Error).message);
      // The attempt was recorded server-side; read it back so the stale banner says what it says.
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const connected = state?.connectionStatus === 'CONNECTED';
  const lastGood = view?.snapshotAt ?? null;
  const filtersActive = ADS_FILTER_PARAMS.some((name) => params.has(name));
  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accounts)
      map.set(
        account.client?.id ?? ADS_CLIENT_UNASSIGNED,
        account.client?.name ?? ADS_CLIENT_UNASSIGNED_LABEL,
      );
    return [...map.entries()].sort(([a, an], [b, bn]) =>
      a === ADS_CLIENT_UNASSIGNED ? 1 : b === ADS_CLIENT_UNASSIGNED ? -1 : an.localeCompare(bn),
    );
  }, [accounts]);
  const accountOptions = state ? adsAccountsInScope(accounts, { ...filters, account: null }) : [];

  return (
    <div className="page ads-page">
      <PageHead
        eyebrow="Google Ads"
        title="Ads performance"
        body="The figures Google Ads last reported for the accounts you approved. Read-only: this page never changes an account, and opening it never contacts Google."
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing || !connected || accounts.length === 0}
            title={
              connected
                ? 'Read the approved accounts from Google Ads now'
                : 'Connect Google Ads in Settings to refresh'
            }
          >
            <RefreshCw aria-hidden="true" className={refreshing ? 'spin' : undefined} />
            {refreshing ? 'Refreshing…' : 'Refresh from Google'}
          </button>
        }
      />

      {refreshing && (
        <p role="status" className="ads-banner">
          <RefreshCw aria-hidden="true" className="spin" /> Refreshing from Google Ads. The figures
          below stay as they were until it finishes.
        </p>
      )}

      {!state && !loadError && (
        <p role="status" className="ads-banner">
          Loading the stored Ads snapshot…
        </p>
      )}

      {loadError && (
        <p role="alert" className="ads-banner is-error">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>Could not read the Ads snapshot.</strong> {loadError}{' '}
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </span>
        </p>
      )}

      {state && !connected && (
        <p role="status" className="ads-banner is-warning">
          <CircleSlash aria-hidden="true" />
          <span>
            <strong>Google Ads is not connected.</strong>{' '}
            {accounts.length > 0
              ? 'These are the last stored figures and they are not being refreshed. '
              : ''}
            <Link to="/settings">Connect it in Settings.</Link>
          </span>
        </p>
      )}

      {state && (state.lastAttemptFailed || refreshError) && (
        <p role="alert" className="ads-banner is-error">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>The latest refresh failed, so these figures are stale.</strong>{' '}
            {(state.lastAttemptFailed ? state.lastSync.error : null) ||
              refreshError ||
              'Google Ads did not answer.'}{' '}
            {lastGood
              ? `Showing the last successful snapshot, from ${formatDateTime(lastGood)}.`
              : 'There is no earlier snapshot to show.'}
            {state.lastAttemptFailed && state.lastSync.at
              ? ` The failed attempt was at ${formatDateTime(state.lastSync.at)}.`
              : ''}
          </span>
        </p>
      )}

      {state && accounts.length === 0 && (
        <Empty
          title="No approved Ads accounts"
          body={
            connected
              ? 'Approve an account in Settings, then refresh to read its campaigns.'
              : 'Connect Google Ads and approve an account in Settings to see its figures here.'
          }
          action={<Link to="/settings">Open Settings</Link>}
        />
      )}

      {state && accounts.length > 0 && view && (
        <>
          <section className="ads-filters" aria-label="Filters">
            <label>
              Client
              <select
                name="client"
                value={filters.client ?? ''}
                onChange={(event) => setFilter('client', event.target.value)}
              >
                <option value="">All clients</option>
                {clientOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Account
              <select
                name="account"
                value={filters.account ?? ''}
                onChange={(event) => setFilter('account', event.target.value)}
              >
                <option value="">All accounts</option>
                {accountOptions.map((account) => (
                  <option key={account.customerId} value={account.customerId}>
                    {account.descriptiveName} ({formatAdsCustomerId(account.customerId)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              From
              <input
                name="from"
                type="date"
                value={filters.from ?? ''}
                min={bounds?.min}
                max={filters.to ?? bounds?.max}
                disabled={!bounds}
                onChange={(event) => setFilter('from', event.target.value)}
              />
            </label>
            <label>
              To
              <input
                name="to"
                type="date"
                value={filters.to ?? ''}
                min={filters.from ?? bounds?.min}
                max={bounds?.max}
                disabled={!bounds}
                onChange={(event) => setFilter('to', event.target.value)}
              />
            </label>
            {filtersActive && (
              <button type="button" onClick={clearFilters}>
                Clear filters
              </button>
            )}
            <p className="field-hint">
              Dates are each account&apos;s own calendar days, limited to the 90 days stored
              {bounds ? ` (${bounds.min} to ${bounds.max})` : ''}.
            </p>
          </section>

          {ignored.length > 0 && (
            <p role="status" className="ads-banner is-warning">
              <AlertTriangle aria-hidden="true" />
              <span>
                The link named a {ignored.map((name) => FILTER_NOTICE[name]).join(' and ')} this
                snapshot does not have, so that filter was not applied.
              </span>
            </p>
          )}

          <section className="ads-summary" aria-label="Totals for this view">
            <h2>Totals for this view</h2>
            <p className="field-hint">
              {view.accountCount} {view.accountCount === 1 ? 'account' : 'accounts'},{' '}
              {view.campaignCount} {view.campaignCount === 1 ? 'campaign' : 'campaigns'}. Sums of
              Google&apos;s own daily values; one total per currency, never combined.
              {lastGood ? ` Last successful snapshot: ${formatDateTime(lastGood)}.` : ''}
            </p>
            {view.currencyTotals.length === 0 ? (
              <p className="ads-none">
                <CircleSlash aria-hidden="true" /> No measured days in this view, so there are no
                totals. An empty total is not a zero.
              </p>
            ) : (
              view.currencyTotals.map((entry) => (
                <div key={entry.currencyCode} className="ads-currency">
                  <h3>
                    {entry.currencyCode}{' '}
                    <span className="field-hint">
                      {entry.accounts} {entry.accounts === 1 ? 'account' : 'accounts'} ·{' '}
                      {entry.measuredDays} campaign-days
                    </span>
                  </h3>
                  <Figures
                    totals={entry.totals}
                    currencyCode={entry.currencyCode}
                    label={`Totals in ${entry.currencyCode}`}
                  />
                </div>
              ))
            )}
          </section>

          {view.groups.length === 0 && (
            <Empty
              title="No account matches these filters"
              body="Clear a filter to see more accounts."
              compact
            />
          )}

          {view.groups.map((group) => (
            <section
              key={group.key}
              className={`ads-group ${group.client ? '' : 'is-unassigned'}`}
              aria-label={`Client: ${group.name}`}
            >
              <h2>
                {group.client ? null : <UserX aria-hidden="true" />}
                {group.name}
                {group.client?.status === 'ARCHIVED' && (
                  <span className="field-hint"> (archived client)</span>
                )}
              </h2>
              {!group.client && (
                <p className="field-hint">
                  These accounts are approved but not mapped to a client. Map them in{' '}
                  <Link to="/settings">Settings</Link>.
                </p>
              )}
              {group.accounts.map(({ account, campaigns, totals, measuredDays }) => (
                <article
                  key={account.customerId}
                  className="ads-account"
                  aria-label={`Account ${account.descriptiveName}`}
                >
                  <header>
                    <h3>
                      {account.descriptiveName}{' '}
                      <span className="field-hint">{formatAdsCustomerId(account.customerId)}</span>
                    </h3>
                    <p className="ads-account-meta">
                      <span>{account.currencyCode}</span>
                      <span>Time zone {account.timeZone}</span>
                      {account.window ? (
                        <span>
                          Days {account.window.startDate} to {account.window.endDate}{' '}
                          (account-local)
                        </span>
                      ) : null}
                      <span>
                        {account.syncedAt ? (
                          <>
                            <Clock aria-hidden="true" /> Snapshot {formatDateTime(account.syncedAt)}
                          </>
                        ) : (
                          'Not refreshed yet'
                        )}
                      </span>
                    </p>
                  </header>
                  {account.stale && (
                    <p className="ads-banner is-warning" role="status">
                      <AlertTriangle aria-hidden="true" /> {ADS_STALE_MESSAGE[account.stale]}
                    </p>
                  )}
                  {!account.approved && (
                    <p className="ads-banner is-warning" role="status">
                      <AlertTriangle aria-hidden="true" /> Approval was withdrawn. This is the last
                      snapshot and it is not being refreshed.
                    </p>
                  )}
                  {!account.syncedAt ? (
                    <p className="ads-none">
                      <CircleSlash aria-hidden="true" /> No figures yet. Press{' '}
                      <strong>Refresh from Google</strong> to read this account.
                    </p>
                  ) : campaigns.length === 0 ? (
                    <p className="ads-none">
                      <CircleSlash aria-hidden="true" /> Google reported no campaigns for this
                      account.
                    </p>
                  ) : (
                    <>
                      {totals ? (
                        <Figures
                          totals={totals}
                          currencyCode={account.currencyCode}
                          label={`Totals for ${account.descriptiveName}`}
                        />
                      ) : (
                        <p className="ads-none">
                          <CircleSlash aria-hidden="true" /> No measured days in this range, so no
                          totals for this account.
                        </p>
                      )}
                      <p className="field-hint">{measuredDays} campaign-days measured.</p>
                      <div className="ads-table-wrap">
                        <table className="ads-campaigns">
                          <caption>Campaigns in {account.descriptiveName}</caption>
                          <thead>
                            <tr>
                              <th scope="col">Campaign</th>
                              <th scope="col">Status</th>
                              {ADS_FIGURES.map((figure) => (
                                <th scope="col" key={figure} className="num">
                                  {ADS_FIGURE_LABEL[figure]}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {campaigns.map((row) => (
                              <tr key={row.campaign.campaignId}>
                                <th scope="row">
                                  {row.campaign.name}
                                  <span className="field-hint"> {row.campaign.channelType}</span>
                                </th>
                                <td>{row.campaign.status}</td>
                                {row.totals ? (
                                  ADS_FIGURES.map((figure) => (
                                    <td key={figure} className="num">
                                      {figure === 'costMicros'
                                        ? formatAdsCost(
                                            row.totals!.costMicros,
                                            account.currencyCode,
                                          )
                                        : row.totals![figure].toLocaleString(undefined, {
                                            maximumFractionDigits: 2,
                                          })}
                                    </td>
                                  ))
                                ) : (
                                  <td colSpan={ADS_FIGURES.length} className="ads-no-days">
                                    <CircleSlash aria-hidden="true" />{' '}
                                    {row.neverMeasured
                                      ? 'No metric rows reported'
                                      : 'No measured days in this range'}
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </article>
              ))}
            </section>
          ))}

          {state.lastSync.outcome === 'SUCCESS' && !state.lastAttemptFailed && lastGood && (
            <p className="field-hint ads-fresh">
              <CheckCircle2 aria-hidden="true" /> The latest refresh succeeded.
            </p>
          )}
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, MinusCircle, RotateCcw } from 'lucide-react';
import { api } from '../api';
import {
  SIGNAL_CAMPAIGN_NONE,
  SIGNAL_CAMPAIGN_NONE_LABEL,
  signalCampaignTrendPeak,
  type SignalCampaignAnalytics,
  type SignalCampaignAnalyticsGroup,
} from '../../../shared/signal-campaign-analytics';
import {
  ANALYTICS_METRICS,
  ANALYTICS_METRIC_LABEL,
  type AnalyticsMetric,
  type PostMetricDay,
  type PostMetricTotals,
} from '../../../shared/publish-analytics';
import { SIGNAL_CHANNEL_LABEL, isSignalDate } from '../../../shared/signal';
import { Empty } from './Primitives';

/**
 * What the platforms counted, grouped by the campaign the post belongs to.
 *
 * A local read on the server: opening this panel, or changing a filter, contacts no provider and
 * spends no synchronisation. The numbers are the ones somebody's own **Refresh figures** press
 * already stored against a post, which is why there is no refresh control here at all — the place to
 * fetch a figure is the post it belongs to.
 *
 * Nothing here calculates a figure beyond the addition `shared/signal-campaign-analytics.ts` decides
 * and performs. Every group says how many of its deliveries are measured beside its total, and a
 * group with none says so in words rather than showing a row of zeros.
 *
 * The filters are durable URL state per `docs/view-state-convention.md`: `campaigns`, `channels`,
 * `accounts`, `from`, and `to`, each omitted when it is the default, each read defensively.
 */

/** The four figures as a row of labelled numbers, in the analytics contract's own order. */
function Totals({ totals, label }: { totals: PostMetricTotals; label: string }) {
  return (
    <dl className="signal-metric-totals" aria-label={label}>
      {ANALYTICS_METRICS.map((metric) => (
        <div className="signal-metric-total" key={metric}>
          <dt>{ANALYTICS_METRIC_LABEL[metric]}</dt>
          {/* Grouped by the reader's own locale, which is the only formatting applied to a number
              anywhere in this panel. */}
          <dd>{totals[metric].toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A compact daily trend: one bar per day the provider snapshotted, and the same days as a table.
 *
 * The bars are decoration and are hidden from assistive technology, because a height is not a
 * number. The table beside them is the trend — every day, all four figures — so the panel says the
 * same thing to a reader who cannot see the bars, which is the rule every status in this app follows.
 *
 * Each bar is scaled against the largest gain in the run rather than against a fixed ceiling: the
 * shape of a campaign's week is what a trend is read for, and a fixed axis would flatten every
 * campaign that is not the busiest one.
 */
function Trend({
  trend,
  metric,
  caption,
}: {
  trend: PostMetricDay[];
  metric: AnalyticsMetric;
  caption: string;
}) {
  if (!trend.length) return null;
  const peak = signalCampaignTrendPeak(trend, metric);
  return (
    <div className="signal-campaign-trend">
      <div className="signal-campaign-bars" aria-hidden="true">
        {trend.map((day) => (
          <span
            key={day.date}
            className="signal-campaign-bar"
            // A day that gained nothing keeps a visible sliver rather than disappearing: an absent
            // bar and a bar of zero would read as the same thing, and only one of them is true.
            style={{ height: `${peak > 0 ? Math.max(6, (day[metric] / peak) * 100) : 6}%` }}
            title={`${day.date}: ${day[metric].toLocaleString()} ${ANALYTICS_METRIC_LABEL[
              metric
            ].toLowerCase()}`}
          />
        ))}
      </div>
      <details className="signal-metric-days">
        <summary>
          {trend.length === 1 ? 'One day of history' : `${trend.length} days of history`}
        </summary>
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {ANALYTICS_METRICS.map((name) => (
                <th scope="col" key={name}>
                  {ANALYTICS_METRIC_LABEL[name]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...trend].reverse().map((day) => (
              <tr key={day.date}>
                {/* The provider's own day label, shown as it was stored and never parsed. */}
                <th scope="row">{day.date}</th>
                {ANALYTICS_METRICS.map((name) => (
                  <td key={name}>{day[name].toLocaleString()}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const measuredWord = (group: { deliveries: number; measuredDeliveries: number }) =>
  `${group.measuredDeliveries} of ${group.deliveries} ${
    group.deliveries === 1 ? 'delivery' : 'deliveries'
  } measured`;

/** One campaign's answer, or **No campaign**'s. */
function Group({
  group,
  metric,
}: {
  group: SignalCampaignAnalyticsGroup;
  metric: AnalyticsMetric;
}) {
  const measured = group.measuredDeliveries > 0;
  const Icon = measured ? BarChart3 : MinusCircle;
  return (
    <li
      className={`signal-campaign-group ${measured ? 'is-measured' : ''} ${
        group.campaignId === null ? 'is-uncategorized' : ''
      }`}
    >
      <p className="signal-campaign-group-head">
        <strong>{group.name}</strong>
        <span className="signal-campaign-group-scope">
          {group.posts} {group.posts === 1 ? 'post' : 'posts'} · {measuredWord(group)}
        </span>
        <span className="signal-metric-availability">
          <Icon aria-hidden="true" /> {measured ? 'Figures from the platforms' : 'No figures yet'}
        </span>
      </p>
      {group.totals ? (
        <>
          <Totals totals={group.totals} label={`Figures for ${group.name}`} />
          <Trend
            trend={group.trend}
            metric={metric}
            caption={`New engagement gained each day across ${group.name}, from the providers’ daily snapshots.`}
          />
        </>
      ) : (
        <p className="signal-metric-unavailable">
          Nothing here has been measured yet. Open a post and press <strong>Refresh figures</strong>{' '}
          to ask the provider — a channel it does not measure never gains one, which is different
          from a count of zero.
        </p>
      )}
    </li>
  );
}

/**
 * One filter value, on or off.
 *
 * The same toggle chip the board's tag filter uses, so a filter behaves the same way in both places
 * — `aria-pressed` carries the state, and the class only paints it.
 */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`tag-chip toggle ${active ? 'active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** A comma-separated URL parameter, read defensively: unknown members are simply not applied. */
const listParam = (value: string | null) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

export function SignalCampaignAnalyticsPanel({ reloadKey }: { reloadKey: number }) {
  const [params, setParams] = useSearchParams();
  const [summary, setSummary] = useState<SignalCampaignAnalytics | null>(null);
  const [error, setError] = useState('');
  /**
   * Which of the four figures the bars are drawn for. Local rather than durable: it changes what a
   * decoration looks like and nothing about what the panel says, and the table under it carries all
   * four regardless.
   */
  const [metric, setMetric] = useState<AnalyticsMetric>('views');

  // Read defensively, per `docs/view-state-convention.md`: an id the workspace no longer has simply
  // matches nothing, and a date that is not a real day is ignored rather than failing the page.
  const campaignIds = listParam(params.get('campaigns'));
  const channels = listParam(params.get('channels'));
  const accounts = listParam(params.get('accounts'));
  const from = isSignalDate(params.get('from') ?? '') ? (params.get('from') as string) : '';
  const to = isSignalDate(params.get('to') ?? '') ? (params.get('to') as string) : '';
  /**
   * The request, as one string.
   *
   * Rebuilt every render rather than memoized: it is three joins and a comparison, and a primitive
   * is what the effect below can honestly depend on — a memoized array would change identity on
   * every render anyway and re-fetch for no reason.
   */
  const query = (() => {
    const search = new URLSearchParams();
    if (campaignIds.length) search.set('campaigns', campaignIds.join(','));
    if (channels.length) search.set('channels', channels.join(','));
    if (accounts.length) search.set('accounts', accounts.join(','));
    if (from) search.set('from', from);
    // A range that ends before it starts is refused by the API, so it is not sent: the two inputs
    // are filled one at a time, and half a range should not turn the panel into an error.
    if (to && (!from || from <= to)) search.set('to', to);
    return search.toString();
  })();

  useEffect(() => {
    api<SignalCampaignAnalytics>(`/signal/analytics/campaigns${query ? `?${query}` : ''}`)
      .then((next) => {
        setSummary(next);
        setError('');
      })
      .catch((reason: Error) => setError(reason.message));
    // `reloadKey` is the planner saying it changed something this reads: a post's campaigns can move
    // between groups, and the panel has no way of knowing that on its own.
  }, [query, reloadKey]);

  /** Sets or clears one parameter, leaving every other one in the address alone. */
  const setParam = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const toggle = (key: string, chosen: string[], value: string) =>
    setParam(
      key,
      (chosen.includes(value) ? chosen.filter((item) => item !== value) : [...chosen, value]).join(
        ',',
      ),
    );
  const clear = () =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of ['campaigns', 'channels', 'accounts', 'from', 'to']) next.delete(key);
        return next;
      },
      { replace: true },
    );
  const filtered = Boolean(campaignIds.length || channels.length || accounts.length || from || to);

  // A refusal before anything has loaded is all there is to show. Once a summary has arrived it is
  // kept and the refusal is shown above it instead, so the filters that caused it stay reachable —
  // a panel that replaced itself with an error would be a filter nobody could undo.
  if (!summary)
    return error ? (
      <section className="panel signal-campaign-analytics" aria-label="Campaign figures">
        <div className="refresh-error" role="alert">
          {error}
        </div>
      </section>
    ) : null;

  return (
    <section className="panel signal-campaign-analytics" aria-label="Campaign figures">
      <div className="section-title">
        <div>
          <span className="eyebrow">Signal Campaign</span>
          <h2>Campaign figures</h2>
        </div>
        <span className="version-pill">
          {summary.scope.posts} {summary.scope.posts === 1 ? 'post' : 'posts'}
        </span>
      </div>
      {error && (
        <div className="refresh-error" role="alert">
          {error}
        </div>
      )}
      <p className="signal-metrics-note">
        The platforms’ own counts, added up across the deliveries of the posts in each campaign.
        Nothing is fetched here — these are the figures a post’s own{' '}
        <strong>Refresh figures</strong> already stored. A date range asks which <em>posts</em>, not
        which days: a post inside it brings its whole measured history.
      </p>

      <div className="signal-campaign-filters">
        <fieldset>
          <legend>Campaigns</legend>
          <div className="signal-campaign-chips">
            {summary.campaigns.map((campaign) => (
              <FilterChip
                key={campaign.id}
                label={campaign.name}
                active={campaignIds.includes(campaign.id)}
                onClick={() => toggle('campaigns', campaignIds, campaign.id)}
              />
            ))}
            {/* Unclassified posts are a group a person can ask for by name, not a residue that can
                only be reached by clearing every other filter. */}
            <FilterChip
              label={SIGNAL_CAMPAIGN_NONE_LABEL}
              active={campaignIds.includes(SIGNAL_CAMPAIGN_NONE)}
              onClick={() => toggle('campaigns', campaignIds, SIGNAL_CAMPAIGN_NONE)}
            />
          </div>
          <p className="signal-campaign-hint">
            Several campaigns are read as <strong>or</strong>: a post in any of them is counted.
          </p>
        </fieldset>
        {summary.channels.length > 0 && (
          <fieldset>
            <legend>Channels</legend>
            <div className="signal-campaign-chips">
              {summary.channels.map((channel) => (
                <FilterChip
                  key={channel}
                  label={SIGNAL_CHANNEL_LABEL[channel]}
                  active={channels.includes(channel)}
                  onClick={() => toggle('channels', channels, channel)}
                />
              ))}
            </div>
          </fieldset>
        )}
        {summary.accounts.length > 0 && (
          <fieldset>
            <legend>Accounts</legend>
            <div className="signal-campaign-chips">
              {summary.accounts.map((account) => (
                <FilterChip
                  key={account.accountId}
                  // The handle the publication snapshotted, so an account stays recognisable after a
                  // rename; the channel names it where the provider gave no handle at all.
                  label={account.handle || SIGNAL_CHANNEL_LABEL[account.channel]}
                  active={accounts.includes(String(account.accountId))}
                  onClick={() => toggle('accounts', accounts, String(account.accountId))}
                />
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className="signal-campaign-range">
          <legend>Dates</legend>
          <label>
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setParam('from', event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              onChange={(event) => setParam('to', event.target.value)}
            />
          </label>
        </fieldset>
        <div className="signal-campaign-filter-actions">
          <label>
            Trend figure
            <select
              value={metric}
              onChange={(event) => setMetric(event.target.value as AnalyticsMetric)}
            >
              {ANALYTICS_METRICS.map((name) => (
                <option value={name} key={name}>
                  {ANALYTICS_METRIC_LABEL[name]}
                </option>
              ))}
            </select>
          </label>
          {filtered && (
            <button type="button" className="secondary" onClick={clear}>
              <RotateCcw /> Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Deliberately not a live region. It is a heading for the totals under it rather than an
          announcement, and the planner already has two live regions a reader is listening to. */}
      <p className="signal-campaign-scope">
        {summary.scope.posts} {summary.scope.posts === 1 ? 'post' : 'posts'} in scope ·{' '}
        {measuredWord(summary.scope)}.
      </p>
      {summary.totals ? (
        <>
          <Totals totals={summary.totals} label="Figures across every campaign in scope" />
          <Trend
            trend={summary.trend}
            metric={metric}
            caption="New engagement gained each day across everything in scope, from the providers’ daily snapshots."
          />
        </>
      ) : (
        <p className="signal-metric-unavailable">
          Nothing in scope has been measured yet, so there is no total to show. A count of zero
          would be a measurement, and no measurement has been taken.
        </p>
      )}

      {summary.groups.length ? (
        <ul className="signal-campaign-groups">
          {summary.groups.map((group) => (
            <Group key={group.campaignId ?? SIGNAL_CAMPAIGN_NONE} group={group} metric={metric} />
          ))}
        </ul>
      ) : (
        <Empty
          compact
          title="No posts match"
          body={
            filtered
              ? 'Nothing is in scope with these filters. Clear them to see every campaign.'
              : 'Add a campaign to a post and it will be grouped here.'
          }
        />
      )}
    </section>
  );
}

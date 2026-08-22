import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, BarChart3, Hash, HelpCircle, MinusCircle, RefreshCw } from 'lucide-react';
import { api, send } from '../api';
import {
  analyticsMatchPhrase,
  postMetricDayDeltas,
  postMetricAvailabilityDetail,
  postMetricAvailabilityLabel,
  postMetricsMeasurable,
  ANALYTICS_MATCH_DETAIL,
  ANALYTICS_METRIC_LABEL,
  ANALYTICS_METRICS,
  ANALYTICS_PLATFORM_POST_HEADING,
  type PostMetricsSummary,
  type PostTargetMetrics,
} from '../../../shared/publish-analytics';
import { PUBLISH_PLATFORM_LABEL } from '../../../shared/publish-capabilities';
import { SIGNAL_CHANNEL_LABEL } from '../../../shared/signal';

/**
 * What the platforms counted, for one post.
 *
 * Read on open and refreshed only when somebody asks. The `GET` this makes on mount touches no
 * provider — it reads the figures already stored — so opening a post cannot spend a synchronisation
 * against an endpoint whose documented `429` says to wait between them. **Refresh figures** is the
 * only control here that reaches Post Bridge, and there is no timer anywhere in this component.
 *
 * Nothing here computes a figure. The four numbers are the provider's own, the per-day gains are
 * subtracted from stored snapshots by `shared/publish-analytics.ts`, and a channel with no figures
 * says which of the three reasons it has rather than showing a zero — a zero is a measurement, and
 * "nobody measures this" is not one.
 */

/** The four figures as a row of labelled numbers, in the contract's own order. */
function Totals({ target }: { target: PostTargetMetrics }) {
  if (!target.totals) return null;
  const totals = target.totals;
  return (
    <dl className="signal-metric-totals">
      {ANALYTICS_METRICS.map((metric) => (
        <div className="signal-metric-total" key={metric}>
          <dt>{ANALYTICS_METRIC_LABEL[metric]}</dt>
          {/* Grouped by the reader's own locale, which is the only formatting applied to a
              provider's number anywhere in this panel. */}
          <dd>{totals[metric].toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The days behind the totals, newest first, as gains rather than cumulative counts.
 *
 * Gains are what a person reads a day list for — *did the second day do anything* — and they are
 * derived here from the snapshots that were stored rather than from the provider's own delta array,
 * so the table cannot disagree with the totals above it. The earliest snapshot has no previous day
 * to subtract and so is not a row; that is the provider's own rule, applied to the days this app
 * actually holds.
 */
function Days({ target }: { target: PostTargetMetrics }) {
  const deltas = postMetricDayDeltas(target.days);
  if (!deltas.length) return null;
  return (
    <details className="signal-metric-days">
      <summary>
        {deltas.length === 1 ? 'One day of history' : `${deltas.length} days of history`}
      </summary>
      <table>
        <caption>New engagement gained each day, from the provider’s daily snapshots.</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {ANALYTICS_METRICS.map((metric) => (
              <th scope="col" key={metric}>
                {ANALYTICS_METRIC_LABEL[metric]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...deltas].reverse().map((day) => (
            <tr key={day.date}>
              {/* The provider's own date string, shown as it was stored. It is a day label rather
                  than an instant, so nothing here parses it into one. */}
              <th scope="row">{day.date}</th>
              {ANALYTICS_METRICS.map((metric) => (
                <td key={metric}>{day[metric].toLocaleString()}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * How the provider says it matched this record, and the platform's own identifier for what it
 * measured.
 *
 * **Provenance, not a hedge on the numbers.** The vendor's field is called `match_confidence`, and
 * read quickly that sounds like a margin of error on the four counts above. It is not: it is the
 * provider saying how sure it is that this record is *about* this piece of platform content. So the
 * words are `Provider match`, the sentence underneath says what it is not, and the counts are left
 * to stand on their own.
 *
 * Rendered only where the provider actually said something. A record that arrived without either
 * field shows nothing at all rather than a default — an empty provenance line reads as a claim, and
 * there is none to make. A value this build has words for gets them; anything else is shown as the
 * provider's own token behind `Provider value:`, with its own icon, so an unfamiliar value is
 * legible as unfamiliar rather than dressed up as `Exact`.
 *
 * The identifier is text and never a link. `shareUrl` above is the address the provider gave, and
 * assembling one per platform out of an id would be this app inventing a URL nobody supplied.
 */
function Provenance({ target }: { target: PostTargetMetrics }) {
  if (!target.matchConfidence && !target.platformPostId) return null;
  const phrase = target.matchConfidence ? analyticsMatchPhrase(target.matchConfidence) : undefined;
  // Two icons rather than two colours: the difference between a value this build knows and one it
  // does not survives greyscale, and neither reading is a status worth colouring.
  const MatchIcon = phrase?.known ? BadgeCheck : HelpCircle;
  return (
    <p className="signal-metric-match">
      {phrase && (
        <span className="signal-metric-match-value">
          <MatchIcon aria-hidden="true" /> {phrase.text}
        </span>
      )}
      {target.platformPostId && (
        <span className="signal-metric-match-id">
          <Hash aria-hidden="true" /> {ANALYTICS_PLATFORM_POST_HEADING}: {target.platformPostId}
        </span>
      )}
      {phrase && <span className="signal-metric-match-detail">{ANALYTICS_MATCH_DETAIL}</span>}
    </p>
  );
}

/** One delivery's figures, or the reason it has none. */
function TargetFigures({ target }: { target: PostTargetMetrics }) {
  const platformLabel = target.platform
    ? PUBLISH_PLATFORM_LABEL[target.platform]
    : SIGNAL_CHANNEL_LABEL[target.channel];
  const available = target.availability === 'AVAILABLE';
  const Icon = available ? BarChart3 : MinusCircle;
  return (
    <li className={`signal-metric-target availability-${target.availability.toLowerCase()}`}>
      <p className="signal-metric-target-head">
        <strong>{SIGNAL_CHANNEL_LABEL[target.channel]}</strong>
        {target.handle ? ` → ${target.handle}` : ''}{' '}
        {/* The state carries its own icon and its own words beside the colour, so the difference
            between measured and unmeasured survives greyscale and a screen reader. */}
        <span className="signal-metric-availability">
          <Icon aria-hidden="true" />{' '}
          {postMetricAvailabilityLabel(target.availability, target.outcome)}
        </span>
      </p>
      {available ? (
        <>
          <Totals target={target} />
          <Days target={target} />
          <p className="signal-metric-provenance">
            {target.providerSyncedAt
              ? `${platformLabel} last counted these on ${new Date(target.providerSyncedAt).toLocaleString()}.`
              : `${platformLabel} did not say when it last counted these.`}
            {target.shareUrl && (
              <>
                {' '}
                <a href={target.shareUrl} target="_blank" rel="noreferrer noopener">
                  Open it on {platformLabel}
                </a>
              </>
            )}
          </p>
          <Provenance target={target} />
        </>
      ) : (
        <p className="signal-metric-unavailable">
          {postMetricAvailabilityDetail(target.availability, target.outcome)}
        </p>
      )}
    </li>
  );
}

/**
 * Mounted under a key made of the result identities the deliveries are carrying (`SignalView`), so a
 * delivery refresh that captures an identity there was none of before starts this panel again and it
 * re-reads. Until it hears about one it is correctly saying it has nothing to ask about, and a render
 * that captured nothing new leaves it exactly as it is.
 */
export function SignalMetrics({ postId, busy }: { postId: string; busy: boolean }) {
  const [summary, setSummary] = useState<PostMetricsSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The stored figures. A local read on the server, so this is the request the panel makes on open
   * and the one it makes after a refresh — never a provider call of its own.
   */
  const load = useCallback(() => {
    api<PostMetricsSummary>(`/signal/posts/${postId}/metrics`)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [postId]);
  useEffect(load, [load]);

  /** The one control that reaches the provider, and only because somebody pressed it. */
  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      // The route answers with the summary whether the provider cooperated or not: a refusal comes
      // back carrying the stored figures and its own reason, which is why this replaces the state
      // rather than leaving it alone on failure.
      setSummary(await send<PostMetricsSummary>(`/signal/posts/${postId}/metrics/refresh`, 'POST'));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  if (!summary || !summary.targets.length) return null;
  const measurable = postMetricsMeasurable(summary);
  return (
    <section className="signal-metrics" aria-label="Figures">
      <h3>Figures</h3>
      <p className="signal-metrics-note">
        These are the platforms’ own counts, read through the provider. Nothing here is calculated
        by this app, and nothing here changes the post.
      </p>
      <ul className="signal-metrics-targets">
        {summary.targets.map((target) => (
          <TargetFigures key={`${target.publicationId}:${target.accountId}`} target={target} />
        ))}
      </ul>
      {/* When it was last synchronised, said once for the whole panel: a person asks the question
          once, and a refresh either got through or did not. */}
      <p className="signal-metrics-synced" role="status">
        {summary.lastSyncedAt
          ? `Last synchronised ${new Date(summary.lastSyncedAt).toLocaleString()}.`
          : 'Not synchronised with the provider yet.'}{' '}
        Figures refresh only when you ask.
      </p>
      {summary.refresh.reason && <p className="signal-metrics-reason">{summary.refresh.reason}</p>}
      {error && <p className="form-error">{error}</p>}
      {measurable && (
        <button
          type="button"
          className="secondary"
          onClick={() => void refresh()}
          disabled={busy || refreshing || !summary.refresh.allowed}
        >
          <RefreshCw /> {refreshing ? 'Refreshing figures…' : 'Refresh figures'}
        </button>
      )}
    </section>
  );
}

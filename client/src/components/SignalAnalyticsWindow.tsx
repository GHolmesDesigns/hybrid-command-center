import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarRange, MinusCircle, RefreshCw } from 'lucide-react';
import { api, send } from '../api';
import {
  analyticsWindowCoverage,
  ANALYTICS_WINDOW_DETAIL,
  ANALYTICS_WINDOW_LABEL,
  ANALYTICS_WINDOW_UNVERIFIED_LABEL,
  type AnalyticsWindow,
  type AnalyticsWindowGroup,
  type AnalyticsWindowSnapshot,
} from '../../../shared/publish-analytics-window';
import {
  ANALYTICS_METRICS,
  ANALYTICS_METRIC_LABEL,
  ANALYTICS_PLATFORMS,
  type AnalyticsPlatform,
  type PostMetricTotals,
} from '../../../shared/publish-analytics';
import { SIGNAL_CHANNEL_LABEL } from '../../../shared/signal';
import { Empty } from './Primitives';

/**
 * What the provider reports for one platform over one of its own windows.
 *
 * ## A second question, and it says so
 *
 * This is not the per-post figures panel and it is not a replacement for it. That panel answers *what
 * did this delivery get*, asked per delivery; this answers *what does the provider report for this
 * platform over this window*, which is one request instead of a walk. The two can legitimately differ,
 * because the provider chose which deliveries a window names and this app chose which deliveries a
 * per-post refresh asked about — so nothing here overwrites, hides, or corrects a number on a post.
 *
 * ## No window is offered today, and the panel says why rather than guessing
 *
 * The endpoint takes a window filter. What that filter *selects* — which posts are included, or which
 * measurement days are counted — has not been observed, and §14 of
 * `docs/post-bridge-api-surface.md` records it as unverified. So the control offers exactly the
 * windows `ANALYTICS_WINDOW_EVIDENCE` carries a dated result for, which is none of them, and the panel
 * explains that instead of showing a window labelled with a meaning somebody assumed. When a dated
 * result lands, that one table entry makes the control appear with the meaning the result recorded.
 *
 * ## Nothing here spends a provider request except the button
 *
 * Mounting reads stored rows. Changing platform or window reads stored rows. Neither contacts the
 * provider and neither can reach `analytics/sync` — the interface the server hands this path has no
 * such method. The refresh is the only road out, and a failed one leaves the previous snapshot on
 * screen with the reason above it, because an empty panel where a stored window should be would
 * present a failure as an absence of figures.
 *
 * ## Every judgement comes from the shared rules
 *
 * Which rows are unmapped, how a group's coverage reads, and what a window is called are all decided
 * in `shared/publish-analytics-window.ts` on the server's side of the read. This component formats and
 * nothing else, so the panel and the stored snapshot cannot disagree about what was measured.
 *
 * The selection is local component state rather than durable URL state. There is nothing durable to
 * hold while no window is offered, and `docs/view-state-convention.md` asks for a default a link can
 * reproduce — which a window whose meaning is unverified cannot be.
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
 * One account's row: who it is, how much of it the window named, and the sum where there is one.
 *
 * A group with nothing measured carries no total rather than four zeros, and the sentence beside it
 * says which of the two it is — the distinction `postMetricAvailability` draws for one delivery,
 * carried up to an account.
 */
function Group({ group }: { group: AnalyticsWindowGroup }) {
  const name = `${group.handle} (${SIGNAL_CHANNEL_LABEL[group.channel]})`;
  return (
    <li className="signal-window-group">
      <p className="signal-window-group-head">
        <strong>{group.handle}</strong>
        <span className="signal-window-group-channel">{SIGNAL_CHANNEL_LABEL[group.channel]}</span>
        <span className="signal-window-group-account">Account {group.accountId}</span>
      </p>
      <p className="signal-window-coverage">{analyticsWindowCoverage(group)}</p>
      {group.totals ? (
        <Totals totals={group.totals} label={`Window figures for ${name}`} />
      ) : (
        <p className="signal-window-nothing">
          <MinusCircle aria-hidden="true" /> No total for this account in this window.
        </p>
      )}
    </li>
  );
}

export function SignalAnalyticsWindowPanel({ reloadKey = 0 }: { reloadKey?: number }) {
  const [platform, setPlatform] = useState<AnalyticsPlatform>(ANALYTICS_PLATFORMS[0]);
  // `all` is the vendor's own default for the parameter, so it is what an unconfigured panel asks
  // about. It is a request, not a claim: the server answers with `verified: false` for it today.
  const [timeframe, setTimeframe] = useState<AnalyticsWindow>('all');
  const [snapshot, setSnapshot] = useState<AnalyticsWindowSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (run: () => Promise<AnalyticsWindowSnapshot>) => {
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
    () =>
      act(() =>
        api<AnalyticsWindowSnapshot>(
          `/signal/analytics/window?platform=${platform}&timeframe=${timeframe}`,
        ),
      ),
    [act, platform, timeframe],
  );

  useEffect(() => {
    // A local read of stored rows on every selection change. No provider call on this path.
    void load();
  }, [load, reloadKey]);

  const offered = snapshot?.windows ?? [];

  useEffect(() => {
    // Settle on a window the build actually offers. `all` is what an unconfigured panel asks about,
    // and while nothing is verified that is the honest selection — but once a dated result makes a
    // window available, showing a selection nobody can refresh would be a control that does nothing.
    // Read off `snapshot` rather than the derived list, so the dependency is the one stable value.
    const windows = snapshot?.windows ?? [];
    if (windows.length && !windows.includes(timeframe)) setTimeframe(windows[0] as AnalyticsWindow);
  }, [snapshot, timeframe]);

  const refreshable = Boolean(snapshot?.available && snapshot.verified);

  return (
    <section className="signal-window" aria-labelledby="signal-window-title">
      <div className="signal-section-head">
        <div>
          <span className="eyebrow">Provider window</span>
          <h2 id="signal-window-title">What the provider reports over a window</h2>
        </div>
        {refreshable && (
          <button
            className="secondary"
            onClick={() =>
              void act(() =>
                send<AnalyticsWindowSnapshot>('/signal/analytics/window/refresh', 'POST', {
                  platform,
                  timeframe,
                }),
              )
            }
            disabled={busy}
          >
            <RefreshCw className={busy ? 'spin' : ''} /> Refresh window
          </button>
        )}
      </div>

      <p className="signal-window-note">{ANALYTICS_WINDOW_DETAIL}</p>

      <div className="signal-window-controls">
        <label>
          Platform
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as AnalyticsPlatform)}
          >
            {ANALYTICS_PLATFORMS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {/* Only the windows a dated result verifies. An empty list is not a broken control — it is
            the answer, and the sentence below says so. */}
        {offered.length > 0 && (
          <label>
            Window
            <select
              value={timeframe}
              onChange={(event) => setTimeframe(event.target.value as AnalyticsWindow)}
            >
              {offered.map((option) => (
                <option key={option} value={option}>
                  {ANALYTICS_WINDOW_LABEL[option]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && (
        <div className="refresh-error" role="alert">
          {error}
        </div>
      )}

      {snapshot && (
        <>
          {/* The window's meaning, always on screen beside whatever it produced. An unverified
              window's sentence is the whole reason there is no control above. */}
          <p
            className={`signal-window-meaning ${snapshot.verified ? '' : 'is-unverified'}`}
            aria-live="polite"
          >
            {snapshot.verified ? (
              <CalendarRange aria-hidden="true" />
            ) : (
              <AlertTriangle aria-hidden="true" />
            )}
            <span>
              {snapshot.verified
                ? `${ANALYTICS_WINDOW_LABEL[snapshot.window]} · ${snapshot.meaning}`
                : `${ANALYTICS_WINDOW_UNVERIFIED_LABEL} — ${snapshot.meaning}`}
            </span>
          </p>

          {snapshot.reason && (
            <div className="refresh-error" role="status">
              {snapshot.reason}
            </div>
          )}

          {!snapshot.available && (
            <p className="signal-window-nothing">
              Publishing is not configured, so there is nothing to read. Set POST_BRIDGE_API_KEY to
              ask the provider what it reports.
            </p>
          )}

          {snapshot.groups.length === 0 ? (
            <Empty
              compact
              title="No deliveries on this platform"
              body="This workspace has no delivery on this platform that the provider has given a result identity for, so a window read would have nothing to attribute. The per-delivery figures on each post are unaffected."
            />
          ) : (
            <ul className="signal-window-groups">
              {snapshot.groups.map((group) => (
                <Group key={`${group.platform}-${group.accountId}`} group={group} />
              ))}
            </ul>
          )}

          {/* Unmapped rows are a count and a list of the provider's own identities, never folded into
              an account above. */}
          {snapshot.unmapped.length > 0 && (
            <div className="signal-window-unmapped">
              <p>
                <AlertTriangle aria-hidden="true" /> {snapshot.counts.unmapped} of{' '}
                {snapshot.counts.rows}{' '}
                {snapshot.counts.rows === 1 ? 'row the provider named' : 'rows the provider named'}{' '}
                match no delivery recorded here, so they are counted and not attributed to any
                account above.
              </p>
              <ul>
                {snapshot.unmapped.map((row) => (
                  <li key={row.postResultId}>
                    <span>
                      {row.platform} · result {row.postResultId}
                    </span>
                    <Totals
                      totals={row.totals}
                      label={`Unattributed figures for result ${row.postResultId}`}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* `aria-live` rather than `role="status"`, which is the convention the panels beside this
              one follow: the planner already carries a status region, and a second permanent one would
              make "the status" ambiguous both to a screen reader and to a test. */}
          <p className="signal-window-synced" aria-live="polite">
            {snapshot.lastRefreshAt
              ? `Last complete read ${new Date(snapshot.lastRefreshAt).toLocaleString()}. A window refreshes only when you ask.`
              : 'This window has never been read. A window refreshes only when you ask.'}
          </p>
        </>
      )}
    </section>
  );
}

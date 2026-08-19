import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BellOff,
  CheckCircle2,
  Eye,
  RefreshCw,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import { api, send } from '../api';
import {
  QUEUE_ALERT_KIND_LABEL,
  QUEUE_ALERT_SEVERITY_LABEL,
  QUEUE_HEALTH_LIMITS,
  queueHealthHeadline,
  queueHealthIsClear,
  type QueueAlertSeverity,
  type QueueHealthAlert,
  type QueueHealthSummary,
} from '../../../shared/queue-health';
import { SIGNAL_CHANNEL_LABEL, SIGNAL_CHANNELS, type SignalChannel } from '../../../shared/signal';

/**
 * The Signal health summary: what this workspace's own rows say is wrong with it.
 *
 * Every alert here is derived on the server from posts, deliveries, and the record of the last
 * provider synchronisation — this component decides nothing and computes nothing. The counts, the
 * headline, and the ordering all come from `shared/queue-health.ts`, so the panel cannot disagree
 * with the rules, and the rules stay testable without rendering anything.
 *
 * Acknowledging is the only thing a person can do to an alert, and it is not a change to the plan or
 * to the delivery: the server writes one row in its own table and returns the same summary with the
 * alert marked. Nothing in this panel can publish, reschedule, or complete anything.
 */

/**
 * A severity, painted and said.
 *
 * The colour is never the only cue — the level carries its own icon shape and its own words, so the
 * two stay apart in greyscale, with colours off, and read aloud (`AGENTS.md`).
 */
function SeverityChip({ severity }: { severity: QueueAlertSeverity }) {
  const Icon = severity === 'ACTION' ? AlertTriangle : Eye;
  return (
    <span className={`signal-health-severity severity-${severity.toLowerCase()}`}>
      <Icon aria-hidden="true" />
      {QUEUE_ALERT_SEVERITY_LABEL[severity]}
    </span>
  );
}

function Alert({
  alert,
  busy,
  acknowledge,
  restore,
}: {
  alert: QueueHealthAlert;
  busy: boolean;
  acknowledge: () => void;
  restore: () => void;
}) {
  return (
    <li
      className={`signal-health-alert severity-${alert.severity.toLowerCase()} ${
        alert.acknowledged ? 'is-acknowledged' : ''
      }`}
    >
      <p className="signal-health-alert-head">
        <SeverityChip severity={alert.severity} />
        <span className="signal-health-kind">{QUEUE_ALERT_KIND_LABEL[alert.kind]}</span>
        <strong>{alert.title}</strong>
      </p>
      {/* The link is the subject itself: an alert about a post opens that post, which is the whole
          of what makes the list actionable rather than informative. */}
      <p className="signal-health-alert-subject">
        <Link to={alert.href}>{alert.subject}</Link>
      </p>
      <p className="signal-health-alert-detail">{alert.detail}</p>
      {alert.acknowledged ? (
        <p className="signal-health-alert-acknowledged">
          <CheckCircle2 aria-hidden="true" /> Acknowledged
          {alert.acknowledgedAt ? ` ${new Date(alert.acknowledgedAt).toLocaleString()}` : ''}.{' '}
          <button type="button" className="secondary" onClick={restore} disabled={busy}>
            <Undo2 /> Put back on the list
          </button>
        </p>
      ) : (
        <button type="button" className="secondary" onClick={acknowledge} disabled={busy}>
          <BellOff /> Acknowledge
        </button>
      )}
    </li>
  );
}

/** The windows the rules measure against, edited where the alerts they produced are read. */
function Windows({
  summary,
  busy,
  save,
}: {
  summary: QueueHealthSummary;
  busy: boolean;
  save: (input: Record<string, unknown>) => void;
}) {
  const [approachingHours, setApproachingHours] = useState(String(summary.config.approachingHours));
  const [coverageDays, setCoverageDays] = useState(String(summary.config.coverageDays));
  const [syncStaleHours, setSyncStaleHours] = useState(String(summary.config.syncStaleHours));
  const [channels, setChannels] = useState<SignalChannel[]>(summary.config.coverageChannels);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setApproachingHours(String(summary.config.approachingHours));
    setCoverageDays(String(summary.config.coverageDays));
    setSyncStaleHours(String(summary.config.syncStaleHours));
    setChannels(summary.config.coverageChannels);
  }, [summary.config]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save({
      approachingHours: Number(approachingHours),
      coverageDays: Number(coverageDays),
      syncStaleHours: Number(syncStaleHours),
      coverageChannels: channels,
    });
  };

  return (
    <div className="signal-health-windows">
      <button
        type="button"
        className="secondary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal /> Alert windows
      </button>
      {/* Rendered only while it is open rather than hidden: a form nobody asked for is still a form
          a keyboard walks through, and these three numbers are read far less often than the list. */}
      {open && (
        <form onSubmit={submit}>
          <label>
            Warn this many hours before a slot
            <input
              type="number"
              value={approachingHours}
              min={QUEUE_HEALTH_LIMITS.approachingHours.min}
              max={QUEUE_HEALTH_LIMITS.approachingHours.max}
              onChange={(event) => setApproachingHours(event.target.value)}
            />
          </label>
          <label>
            Expect content this many days ahead
            <input
              type="number"
              value={coverageDays}
              min={QUEUE_HEALTH_LIMITS.coverageDays.min}
              max={QUEUE_HEALTH_LIMITS.coverageDays.max}
              onChange={(event) => setCoverageDays(event.target.value)}
            />
          </label>
          <label>
            Call a synchronisation stale after this many hours
            <input
              type="number"
              value={syncStaleHours}
              min={QUEUE_HEALTH_LIMITS.syncStaleHours.min}
              max={QUEUE_HEALTH_LIMITS.syncStaleHours.max}
              onChange={(event) => setSyncStaleHours(event.target.value)}
            />
          </label>
          <fieldset className="signal-health-channels">
            <legend>Channels coverage is expected on</legend>
            <p>Choose none to ask about every channel this workspace has used.</p>
            {SIGNAL_CHANNELS.map((channel) => (
              <label key={channel}>
                <input
                  type="checkbox"
                  checked={channels.includes(channel)}
                  onChange={(event) =>
                    setChannels((current) =>
                      event.target.checked
                        ? [...current, channel]
                        : current.filter((value) => value !== channel),
                    )
                  }
                />
                {SIGNAL_CHANNEL_LABEL[channel]}
              </label>
            ))}
          </fieldset>
          <button disabled={busy}>Save windows</button>
        </form>
      )}
    </div>
  );
}

export function SignalHealthPanel({ reloadKey = 0 }: { reloadKey?: number }) {
  const [summary, setSummary] = useState<QueueHealthSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setSummary(await api<QueueHealthSummary>('/signal/health'));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // `reloadKey` is the planner saying something it owns has changed. The summary is derived, so
    // the only way to see a post's edit reflected here is to ask for it again.
  }, [load, reloadKey]);

  const act = async (run: () => Promise<QueueHealthSummary>) => {
    setBusy(true);
    setError('');
    try {
      setSummary(await run());
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * One row's two controls, built once. The same alert appears in the live list and, once seen, in
   * the acknowledged one, and both need the same pair — writing them twice is how the two lists end
   * up able to do different things to one alert.
   */
  const controls = (alert: QueueHealthAlert) => {
    const path = `/signal/health/alerts/${encodeURIComponent(alert.id)}/acknowledge`;
    return {
      alert,
      busy,
      acknowledge: () => void act(() => send<QueueHealthSummary>(path, 'POST')),
      restore: () => void act(() => send<QueueHealthSummary>(path, 'DELETE')),
    };
  };

  const live = summary?.alerts.filter((alert) => !alert.acknowledged) ?? [];
  const acknowledged = summary?.alerts.filter((alert) => alert.acknowledged) ?? [];

  return (
    <section className="signal-health" aria-labelledby="signal-health-title">
      <div className="signal-section-head">
        <div>
          <span className="eyebrow">Queue health</span>
          <h2 id="signal-health-title">What needs attention</h2>
        </div>
        <button className="secondary" onClick={() => void load()} disabled={busy}>
          <RefreshCw className={busy ? 'spin' : ''} /> Refresh health
        </button>
      </div>
      {error && (
        <div className="refresh-error" role="alert">
          {error}
        </div>
      )}
      {summary && (
        <>
          {/* Announced politely rather than as a `status` landmark: the planner already has one, and
              two would make a screen reader's list of live regions ambiguous. */}
          <p className="signal-health-headline" aria-live="polite">
            {queueHealthIsClear(summary) ? (
              <CheckCircle2 aria-hidden="true" />
            ) : (
              <AlertTriangle aria-hidden="true" />
            )}{' '}
            {queueHealthHeadline(summary)}
          </p>
          {/* Nothing here changes a plan or a delivery, and the panel says so rather than leaving it
              to be discovered — acknowledging an alert about a failed post must not read as a way of
              resolving the failure. */}
          <p className="signal-health-note">
            Every line is derived from your own posts and deliveries. Acknowledging one records that
            you have seen it and changes nothing about the post, its schedule, or what the provider
            is holding.
          </p>
          {live.length > 0 && (
            <ul className="signal-health-list">
              {live.map((alert) => (
                <Alert key={alert.id} {...controls(alert)} />
              ))}
            </ul>
          )}
          {acknowledged.length > 0 && (
            <div className="signal-health-acknowledged">
              <button
                type="button"
                className="secondary"
                aria-expanded={showAcknowledged}
                onClick={() => setShowAcknowledged((current) => !current)}
              >
                {acknowledged.length} acknowledged
              </button>
              {showAcknowledged && (
                <ul className="signal-health-list">
                  {acknowledged.map((alert) => (
                    <Alert key={alert.id} {...controls(alert)} />
                  ))}
                </ul>
              )}
            </div>
          )}
          <Windows
            summary={summary}
            busy={busy}
            save={(input) =>
              void act(() => send<QueueHealthSummary>('/signal/health/config', 'PUT', input))
            }
          />
        </>
      )}
    </section>
  );
}

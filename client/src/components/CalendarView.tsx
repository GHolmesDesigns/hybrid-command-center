import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  FileText,
  Megaphone,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../api';
import {
  CALENDAR_VIEWS,
  calendarCounts,
  calendarDays,
  calendarViewRange,
  shiftCalendarAnchor,
  type CalendarDay,
  type CalendarRange,
  type CalendarViewMode,
} from '../../../shared/calendar';
import {
  SIGNAL_FORMAT_LABEL,
  SIGNAL_STATUS_LABEL,
  isSignalDate,
  signalChannelPresentation,
  type SignalPost,
} from '../../../shared/signal';
import type { Task } from '../../../shared/types';
import { signalChannelStyle } from './ui-shared';
import { Empty } from './Primitives';
import { PageHead } from './Shell';

/**
 * The calendar: Signal's schedule beside task due dates (FR7, decision §5.7, §8.7).
 *
 * ## Read-only, and structurally so
 *
 * Nothing here writes. There is no control that creates, moves, or reschedules anything, and
 * the API this reads has no counterpart that would accept one — Signal is authoritative for what
 * is scheduled, and this page is a window onto it. Editing lives in the planner.
 *
 * ## An agenda, not a grid
 *
 * Days are listed rather than tiled, and empty days are dropped. Two reasons: a month grid cell
 * cannot hold a post that runs to a thousand characters, and several of these do; and an agenda
 * answers "what is happening and when" without making the reader scan past three empty weeks to
 * find out.
 *
 * ## The two kinds never merge
 *
 * A scheduled post and a task due date live in separate, separately-headed groups within a day,
 * each with its own icon and its own wording. They are never sorted into one list. The
 * distinction survives with the stylesheet turned off, which is the test that matters — colour
 * carries none of it.
 */

/** A day, as the agenda heads it. */
const dayHeading = (date: string) => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  // Built from the parts rather than parsed from the string: `new Date('2026-09-14')` is UTC
  // midnight, which renders as the 13th anywhere west of Greenwich. The calendar's whole rule is
  // that a date is a label, so it is formatted as one.
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
};

const monthHeading = (month: string) => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Date(year, index - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
};

const shortDayHeading = (date: string) => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

/** Today as `YYYY-MM-DD` in local time — the same kind of value the calendar compares. */
const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** One scheduled post. Status is a word, and the channels carry their initials beside colour. */
function PostRow({ post }: { post: SignalPost }) {
  return (
    <li className={`cal-item cal-post status-${post.status.toLowerCase()}`}>
      <div className="cal-item-head">
        <span className="cal-time">{post.time}</span>
        <span className={`cal-status cal-status-${post.status.toLowerCase()}`}>
          {SIGNAL_STATUS_LABEL[post.status]}
        </span>
        <span className="cal-format">{SIGNAL_FORMAT_LABEL[post.format]}</span>
      </div>
      <p className="cal-text">{post.text}</p>
      <div className="cal-item-foot">
        {post.channels.length > 0 && (
          <ul className="cal-channels">
            {post.channels.map((channel) => {
              const { initial, label, ...treatment } = signalChannelPresentation(channel);
              return (
                // The initial is the label; the colour is decoration on top of it.
                <li
                  key={channel}
                  className="cal-channel"
                  data-channel={channel}
                  style={signalChannelStyle(treatment)}
                >
                  <span aria-hidden="true">{initial}</span>
                  <span className="sr-only">{label}</span>
                </li>
              );
            })}
          </ul>
        )}
        {post.campaign && <span className="cal-campaign">{post.campaign}</span>}
      </div>
    </li>
  );
}

/** One task due date. A link, because a task is somewhere you can go. */
function TaskRow({ task }: { task: Task }) {
  const done = task.status === 'COMPLETE';
  return (
    <li className={`cal-item cal-task ${done ? 'is-done' : ''}`}>
      <div className="cal-item-head">
        {done ? (
          <CheckCircle2 className="cal-task-icon" aria-hidden="true" />
        ) : (
          <Circle className="cal-task-icon" aria-hidden="true" />
        )}
        <span className="cal-task-state">{done ? 'Complete' : 'Due'}</span>
        {task.overdue && !done && <span className="cal-overdue">Overdue</span>}
      </div>
      <p className="cal-text">
        <Link to={`/status?project=${task.projectId}`}>{task.title}</Link>
      </p>
      <div className="cal-item-foot">
        {task.projectName && <span className="cal-project">{task.projectName}</span>}
        {task.clientName && <span className="cal-client">{task.clientName}</span>}
      </div>
    </li>
  );
}

function DaySection({ day, isToday }: { day: CalendarDay; isToday: boolean }) {
  return (
    <section className={`cal-day ${isToday ? 'is-today' : ''}`} aria-label={dayHeading(day.date)}>
      <h3 className="cal-day-head">
        {dayHeading(day.date)}
        {isToday && <span className="cal-today-flag">Today</span>}
      </h3>
      {/* Two groups, each headed and each with its own icon. Never one merged list. */}
      {day.posts.length > 0 && (
        <div className="cal-group">
          <h4>
            <Megaphone aria-hidden="true" /> Scheduled content
            <span className="cal-count">{day.posts.length}</span>
          </h4>
          <ul className="cal-list">
            {day.posts.map((post) => (
              <PostRow key={post.id} post={post} />
            ))}
          </ul>
        </div>
      )}
      {day.tasks.length > 0 && (
        <div className="cal-group">
          <h4>
            <FileText aria-hidden="true" /> Task deadlines
            <span className="cal-count">{day.tasks.length}</span>
          </h4>
          <ul className="cal-list">
            {day.tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function CalendarView() {
  const [params, setParams] = useSearchParams();
  const now = today();
  const requestedView = params.get('view');
  const view: CalendarViewMode = CALENDAR_VIEWS.includes(requestedView as CalendarViewMode)
    ? (requestedView as CalendarViewMode)
    : 'month';
  const requestedDate = params.get('date');
  const requestedMonth = params.get('month');
  const anchor = isSignalDate(requestedDate ?? '')
    ? (requestedDate as string)
    : /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth ?? '')
      ? `${requestedMonth}-01`
      : now;
  const bounds = useMemo(() => calendarViewRange(view, anchor), [view, anchor]);

  const [range, setRange] = useState<CalendarRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { from, to } = bounds;
    try {
      setRange(await api<CalendarRange>(`/calendar?from=${from}&to=${to}`));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The calendar could not be loaded.');
      setRange(null);
    } finally {
      setLoading(false);
    }
  }, [bounds]);

  useEffect(() => {
    void load();
  }, [load]);

  const goto = (nextView: CalendarViewMode, nextAnchor: string) => {
    if (nextView === 'month' && nextAnchor.slice(0, 7) === now.slice(0, 7)) {
      setParams({});
      return;
    }
    const next: Record<string, string> = { month: nextAnchor.slice(0, 7) };
    if (nextView !== 'month') {
      next.view = nextView;
      next.date = nextAnchor;
    }
    setParams(next);
  };

  const title =
    view === 'today'
      ? dayHeading(anchor)
      : view === 'week'
        ? `${shortDayHeading(bounds.from)} – ${shortDayHeading(bounds.to)}`
        : monthHeading(anchor.slice(0, 7));
  const spanLabel = view === 'today' ? 'day' : view;

  const days = range ? calendarDays(range) : [];
  const counts = range ? calendarCounts(range) : { posts: 0, tasks: 0 };
  return (
    <>
      <PageHead
        eyebrow="Calendar"
        title={title}
        body="Signal Campaign's schedule beside the work coming due. Read-only — content is scheduled in Signal."
        action={
          <div className="cal-tools">
            <div className="segmented-control cal-view-switch" aria-label="Calendar view">
              {CALENDAR_VIEWS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => goto(option, anchor)}
                >
                  {option === 'today' ? 'Today' : option[0]!.toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
            <div className="cal-nav">
              <button
                className="secondary"
                onClick={() => goto(view, shiftCalendarAnchor(view, anchor, -1))}
                aria-label={`Previous ${spanLabel}`}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <button className="secondary" onClick={() => goto(view, now)}>
                Today
              </button>
              <button
                className="secondary"
                onClick={() => goto(view, shiftCalendarAnchor(view, anchor, 1))}
                aria-label={`Next ${spanLabel}`}
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          </div>
        }
      />

      {/*
        The schedule half failing is a state, not an error page: task deadlines are still shown
        and still correct, and this says which half is missing and why. Silence here would read
        as "nothing is scheduled", which is a different and untrue claim.
      */}
      {range && !range.signal.available && (
        <div className="refresh-status has-error" role="status" aria-live="polite">
          <div>
            <ShieldAlert aria-hidden="true" />
            <span>Signal's schedule could not be read. Showing task deadlines only.</span>
          </div>
          {range.signal.error && <span className="refresh-error-detail">{range.signal.error}</span>}
          <button className="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'spin' : undefined} aria-hidden="true" />
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {range?.signal.truncated && (
        <div className="refresh-status" role="status" aria-live="polite">
          <div>
            <ShieldAlert aria-hidden="true" />
            <span>This {spanLabel} has more scheduled posts than one page shows.</span>
          </div>
        </div>
      )}

      {range && (
        <p className="cal-summary" role="status" aria-live="polite">
          <span>
            <Megaphone aria-hidden="true" /> {counts.posts} scheduled{' '}
            {counts.posts === 1 ? 'post' : 'posts'}
          </span>
          <span>
            <FileText aria-hidden="true" /> {counts.tasks} task{' '}
            {counts.tasks === 1 ? 'deadline' : 'deadlines'}
          </span>
        </p>
      )}

      {error && (
        <div className="refresh-status has-error" role="status" aria-live="polite">
          <div>
            <ShieldAlert aria-hidden="true" />
            <span>{error}</span>
          </div>
          <button className="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'spin' : undefined} aria-hidden="true" />
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {loading && !range && <p className="cal-loading">Loading the calendar…</p>}

      {!loading && !error && days.length === 0 && (
        <Empty
          title={
            view === 'today'
              ? 'Nothing scheduled today'
              : view === 'week'
                ? 'Nothing this week'
                : 'Nothing this month'
          }
          body={`No scheduled content and no task deadlines fall in this ${spanLabel}.`}
        />
      )}

      <div className="cal-agenda">
        {days.map((day) => (
          <DaySection key={day.date} day={day} isToday={day.date === now} />
        ))}
      </div>
    </>
  );
}

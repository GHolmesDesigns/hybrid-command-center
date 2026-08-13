import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  ChevronRight,
  Clock3,
  FolderKanban,
  FolderSync,
  ListChecks,
  Plus,
  RefreshCw,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { send } from '../api';
import type { DashboardData } from '../../../shared/types';
import { type Modal } from './App';
import { formatDataAge, formatDate, initials } from './formatting';
import { Due, Empty, StatusDot } from './Primitives';
import { PageHead } from './Shell';

type DeadlineBucket = 'overdue' | 'today' | 'week';

export function Dashboard({
  dashboard,
  refreshedAt,
  refreshError,
  refreshing,
  open,
  defaultProject,
  refresh,
  flash,
}: {
  dashboard: DashboardData | null;
  refreshedAt: number | null;
  refreshError: string | null;
  refreshing: boolean;
  open: (m: Modal) => void;
  defaultProject?: string;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const nav = useNavigate();
  const [syncing, setSyncing] = useState(false);
  const [bucket, setBucket] = useState<DeadlineBucket>('overdue');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const dataAge = refreshedAt === null ? null : formatDataAge(now - refreshedAt);
  const refreshStatus = (
    <div
      className={`refresh-status ${refreshError ? 'has-error' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div>
        {refreshError ? <ShieldAlert aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        <span>
          {refreshError
            ? dataAge
              ? `Refresh failed. Showing data from ${dataAge}.`
              : 'Refresh failed. Dashboard data is unavailable.'
            : refreshing
              ? 'Refreshing dashboard…'
              : dataAge
                ? `Last refreshed ${dataAge}`
                : 'Dashboard has not refreshed yet.'}
        </span>
      </div>
      {refreshError && <span className="refresh-error-detail">{refreshError}</span>}
      {refreshError && (
        <button className="secondary" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
          {refreshing ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
  if (!dashboard)
    return (
      <>
        {refreshStatus}
        <Empty title="Dashboard unavailable" body="Retry when you are ready." />
      </>
    );
  const plural = (n: number) => (n === 1 ? '' : 's');
  // Three deadline states, each with its own headline, list, and empty state. Overdue leads
  // because it is the one that costs something; the other two are a click away rather than
  // absent, which is what the panel used to be.
  const deadlineBuckets = {
    overdue: {
      label: 'Overdue',
      count: dashboard.counts.overdue,
      tasks: dashboard.overdueTasks,
      boardFilter: 'overdue',
      heading: `${dashboard.counts.overdue} overdue task${plural(dashboard.counts.overdue)}`,
      body: `Across ${dashboard.counts.projectsOverdue} project${plural(dashboard.counts.projectsOverdue)}. Start here.`,
      emptyTitle: 'Nothing overdue',
      emptyBody: 'You are caught up. Keep the momentum going.',
      emptyHint: 'Work that slips past its due date collects here.',
    },
    today: {
      label: 'Due today',
      count: dashboard.counts.dueToday,
      tasks: dashboard.dueTodayTasks,
      boardFilter: 'today',
      heading: `${dashboard.counts.dueToday} task${plural(dashboard.counts.dueToday)} due today`,
      body: 'Everything with today’s date on it, finished work aside.',
      emptyTitle: 'Nothing due today',
      emptyBody: 'Today is clear. Keep an eye on the rest of the week.',
      emptyHint: 'Work carrying today’s date is under Next 7 days too.',
    },
    week: {
      label: 'Next 7 days',
      count: dashboard.counts.dueNextSevenDays,
      tasks: dashboard.upcomingTasks,
      boardFilter: 'week',
      heading: `${dashboard.counts.dueNextSevenDays} task${plural(dashboard.counts.dueNextSevenDays)} due in the next 7 days`,
      body: 'Today through seven days out, today included.',
      emptyTitle: 'A clear week ahead',
      emptyBody: 'Nothing lands in the next seven days.',
      emptyHint: 'Anything due today through seven days out collects here.',
    },
  } as const;
  const shown = deadlineBuckets[bucket];
  // Every tile goes somewhere that shows the rows behind its number. The two deadline
  // tiles reach the board through the same filters the panel's Open board uses, and those
  // filters are calculated by the rules the counts come from, so a tile and its
  // destination cannot disagree.
  const cards = [
    ['Active clients', dashboard.counts.activeClients, <Users />, '/clients'],
    ['Active projects', dashboard.counts.activeProjects, <BriefcaseBusiness />, '/projects'],
    ['Due today', dashboard.counts.dueToday, <Clock3 />, '/status?filter=today'],
    ['Next 7 days', dashboard.counts.dueNextSevenDays, <CalendarDays />, '/status?filter=week'],
  ] as const;
  const syncFolders = async () => {
    setSyncing(true);
    try {
      const result = await send<{ message: string; connected: boolean }>('/drive/sync', 'POST');
      await refresh();
      flash(result.message, result.connected ? 'success' : 'error');
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  };
  return (
    <>
      <PageHead
        eyebrow="Sunday overview"
        title="Your work, in focus."
        body="Deadlines, active projects, and the next decisions that need your attention. Projects live in Command Center — Drive folders are storage, not the source of project records."
        action={
          <div className="head-actions">
            <button className="secondary" onClick={syncFolders} disabled={syncing}>
              {syncing ? (
                <>
                  <RefreshCw className="spin" /> Syncing…
                </>
              ) : (
                <>
                  <FolderSync /> Sync to Folder
                </>
              )}
            </button>
            <button className="secondary" onClick={() => open({ type: 'client' })}>
              <Users /> New client
            </button>
            <button onClick={() => open({ type: 'project' })}>
              <Plus /> New project
            </button>
          </div>
        }
      />
      {refreshStatus}
      <section className="metric-grid">
        {cards.map(([label, value, icon, to]) => (
          // A real anchor, so the browser's own click, Enter, middle-click, and
          // open-in-new-tab all work. The name is spelled out rather than left to the
          // label and figure, which sit in adjacent grid cells with no whitespace between
          // them and run together as "Active clients4"; this announces "Active clients: 4".
          <Link className="metric" key={label} to={to} aria-label={`${label}: ${value}`}>
            <div className="metric-icon">{icon}</div>
            <span>{label}</span>
            <strong>{value}</strong>
          </Link>
        ))}
      </section>
      <section className={`overdue-panel ${dashboard.counts.overdue ? 'has-overdue' : ''}`}>
        <div className="panel-title">
          <div className="alert-icon">
            <ShieldAlert />
          </div>
          <div>
            <span className="eyebrow">Deadlines</span>
            <h2>{shown.count ? shown.heading : shown.emptyTitle}</h2>
            <p>{shown.count ? shown.body : shown.emptyBody}</p>
          </div>
          <button className="secondary" onClick={() => nav(`/status?filter=${shown.boardFilter}`)}>
            Open board <ArrowRight />
          </button>
        </div>
        <div className="bucket-toggle" role="group" aria-label="Deadline state">
          {(Object.keys(deadlineBuckets) as DeadlineBucket[]).map((key) => (
            <button
              key={key}
              className="secondary"
              aria-pressed={bucket === key}
              onClick={() => setBucket(key)}
            >
              {deadlineBuckets[key].label} <span>{deadlineBuckets[key].count}</span>
            </button>
          ))}
        </div>
        {shown.tasks.length > 0 ? (
          <div className="urgent-list">
            {shown.tasks.slice(0, 5).map((t) => (
              <button key={t.id} onClick={() => open({ type: 'taskDetail', value: t })}>
                <span className="priority-stripe" data-priority={t.priority} />
                <div>
                  <strong>{t.title}</strong>
                  <span>
                    {t.clientName} · {t.projectName}
                  </span>
                </div>
                <Due task={t} />
                <ChevronRight />
              </button>
            ))}
          </div>
        ) : (
          <Empty compact title={shown.emptyTitle} body={shown.emptyHint} />
        )}
      </section>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="section-title">
            <div>
              <span className="eyebrow">On the horizon</span>
              <h2>Coming up next</h2>
            </div>
            <button className="text-btn" onClick={() => nav('/status')}>
              See all <ArrowRight />
            </button>
          </div>
          {dashboard.upcomingTasks.length ? (
            <div className="simple-list">
              {dashboard.upcomingTasks.slice(0, 6).map((t) => (
                <button key={t.id} onClick={() => open({ type: 'taskDetail', value: t })}>
                  <StatusDot status={t.status} />
                  <div>
                    <strong>{t.title}</strong>
                    <span>{t.projectName}</span>
                  </div>
                  <Due task={t} />
                </button>
              ))}
            </div>
          ) : (
            <Empty compact title="A clear week ahead" body="Tasks due soon will appear here." />
          )}
        </section>
        <section className="panel">
          <div className="section-title">
            <div>
              <span className="eyebrow">Momentum</span>
              <h2>Recently updated</h2>
            </div>
          </div>
          <div className="project-list">
            {dashboard.recentProjects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`}>
                <div className="monogram">{initials(p.name)}</div>
                <div>
                  <strong>{p.name}</strong>
                  <span>
                    {p.clientName} · {formatDate(p.lastActivityAt)}
                  </span>
                </div>
                <ChevronRight />
              </Link>
            ))}
          </div>
        </section>
      </div>
      <section className="quick-actions">
        <span className="eyebrow">Quick start</span>
        <div>
          <button onClick={() => open({ type: 'client' })}>
            <Users />
            New client
          </button>
          <button onClick={() => open({ type: 'project' })}>
            <BriefcaseBusiness />
            New project
          </button>
          <button onClick={() => open({ type: 'task', projectId: defaultProject })}>
            <ListChecks />
            New task
          </button>
          <button onClick={() => nav('/status')}>
            <FolderKanban />
            Open Status board
          </button>
        </div>
      </section>
    </>
  );
}

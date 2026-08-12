import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertCircle,
  Archive,
  ArrowRight,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileText,
  FolderKanban,
  FolderSync,
  GripVertical,
  LayoutDashboard,
  ListChecks,
  Menu,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Tag as TagIcon,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { api, send } from './api';
import type {
  Client,
  DashboardData,
  DriveStatus,
  Priority,
  Project,
  Tag,
  Task,
  TaskStatus,
  TaskType,
} from '../../shared/types';
import {
  TASK_STATUSES,
  TASK_TYPES,
  compareProjectActivity,
  compareProjectNames,
  normalizeTagName,
  sameTagName,
} from '../../shared/types';
import { isDueNextSevenDays, isDueToday } from '../../shared/deadlines';
import { APP_VERSION, DEFAULT_BRANDING, type Branding } from '../../shared/branding';

const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  REVIEW: 'Review',
  COMPLETE: 'Complete',
};
const STATUS_HELP: Record<TaskStatus, string> = {
  BACKLOG: 'Ideas and incoming work',
  TODO: 'Ready to begin',
  IN_PROGRESS: 'Currently moving',
  REVIEW: 'Waiting for approval',
  COMPLETE: 'Finished work',
};
const TASK_TYPE_LABEL: Record<TaskType, string> = {
  BLOG_POST: 'Blog Post',
  VIDEO: 'Video',
  SOCIAL_POST: 'Social Post',
  GRAPHICS: 'Graphics',
  SCHEDULING: 'Scheduling',
  QA_BRAND_PASS: 'QA / Brand Pass',
  ADMIN: 'Admin',
  OTHER: 'Other',
};
/**
 * A tag as the UI holds it. `id` is missing until the tag exists globally: the chip input
 * accepts a name the moment it is typed, and `syncTaskTags()` creates it on save.
 */
type TagDraft = { id?: string; name: string; color?: string };
/**
 * Accent colors for tags that carry no stored color. Derived from the name so the same tag
 * looks the same everywhere without a color picker. The name is always rendered as text
 * beside it — color never carries meaning on its own.
 */
const TAG_ACCENTS = ['#2f6f52', '#315f79', '#7b4fa8', '#9b5f12', '#a33d63', '#4a6b8a'];
const tagAccent = (tag: TagDraft) => {
  if (tag.color) return tag.color;
  const name = normalizeTagName(tag.name).toLowerCase();
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 100000;
  return TAG_ACCENTS[hash % TAG_ACCENTS.length];
};
type Modal =
  | { type: 'client'; value?: Client }
  | { type: 'project'; value?: Project; clientId?: string }
  | { type: 'task'; value?: Task; projectId?: string }
  | { type: 'taskDetail'; value: Task }
  | null;
const SIDEBAR_KEY = 'hcc-sidebar-collapsed';
const LAST_PROJECT_KEY = 'hcc-last-project';

export function App() {
  const [clients, setClients] = useState<Client[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [tags, setTags] = useState<Tag[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null),
    [loading, setLoading] = useState(true),
    [modal, setModal] = useState<Modal>(null);
  const [dashboardRefreshedAt, setDashboardRefreshedAt] = useState<number | null>(null),
    [dashboardRefreshError, setDashboardRefreshError] = useState<string | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null),
    [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  const [lastProjectId, setLastProjectId] = useState(
    () => localStorage.getItem(LAST_PROJECT_KEY) || '',
  );
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const location = useLocation();
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [c, p, t, d, b, g] = await Promise.all([
        api<Client[]>('/clients'),
        api<Project[]>('/projects'),
        api<Task[]>('/tasks'),
        api<DashboardData>('/dashboard'),
        api<{ branding: Branding }>('/settings/branding'),
        api<Tag[]>('/tags'),
      ]);
      setClients(c);
      setProjects(p);
      setTasks(t);
      setDashboard(d);
      setDashboardRefreshedAt(Date.now());
      setDashboardRefreshError(null);
      setBranding(b.branding);
      setTags(g);
    } catch (e) {
      const message = (e as Error).message;
      setDashboardRefreshError(message);
      setNotice({ tone: 'error', text: message });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem(LAST_PROJECT_KEY, lastProjectId);
  }, [lastProjectId]);
  const flash = (text: string, tone: 'success' | 'error' = 'success') => {
    setNotice({ text, tone });
    window.setTimeout(() => setNotice(null), 3600);
  };
  const saved = async (text: string) => {
    setModal(null);
    await refresh();
    flash(text);
  };
  const toggleCollapse = () => setCollapsed((v) => !v);
  // The remembered project is only a default, and only while TaskForm() still offers it.
  const defaultProject = projects.some((p) => p.id === lastProjectId && p.status !== 'ARCHIVED')
    ? lastProjectId
    : undefined;
  if (loading)
    return (
      <div className="splash">
        <div className="brand-mark">{branding.mark}</div>
        <p>Organizing your command center…</p>
      </div>
    );
  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${navOpen ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <div className="brand-mark" title={branding.title}>
            {branding.mark}
          </div>
          <div className="brand-copy">
            <strong>{branding.title}</strong>
            <span>{branding.subtitle}</span>
          </div>
          <button
            className="icon-btn mobile-close"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <X />
          </button>
        </div>
        <nav aria-label="Primary navigation">
          <Nav icon={<LayoutDashboard />} to="/" label="Dashboard" collapsed={collapsed} />
          <Nav icon={<Users />} to="/clients" label="Clients" collapsed={collapsed} />
          <Nav icon={<BriefcaseBusiness />} to="/projects" label="Projects" collapsed={collapsed} />
          <Nav icon={<FolderKanban />} to="/kanban" label="Status" collapsed={collapsed} />
          {!collapsed && (
            <div className="nav-divider">
              <span>Coming next</span>
            </div>
          )}
          {!collapsed && (
            <>
              <span className="nav-disabled">
                <CalendarDays /> Calendar
              </span>
              <span className="nav-disabled">
                <FileText /> Files
              </span>
              <span className="nav-disabled">
                <Upload /> Import
              </span>
            </>
          )}
          <Nav icon={<Settings />} to="/settings" label="Settings" collapsed={collapsed} />
        </nav>
        <div className="sidebar-foot">
          <button
            className="collapse-btn"
            onClick={toggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeft /> : <PanelLeftClose />}
            {!collapsed && <span>Collapse</span>}
          </button>
          <div className="version-track" title={`Hybrid Command Center ${APP_VERSION}`}>
            <span className="connection-dot" />
            {!collapsed && <span>Local · {branding.tagline}</span>}
            <strong>v{APP_VERSION}</strong>
          </div>
        </div>
      </aside>
      {navOpen && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      )}
      <main>
        <header className="topbar">
          <button
            className="icon-btn menu-btn"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </button>
          <div className="crumb">
            <span>Command Center</span>
            <ChevronRight />
            <strong>{pageName(location.pathname)}</strong>
          </div>
          <button
            className="top-action"
            onClick={() => setModal({ type: 'task', projectId: defaultProject })}
          >
            <Plus /> New task
          </button>
        </header>
        <div className="page-wrap">
          <Routes>
            <Route
              path="/"
              element={
                <Dashboard
                  dashboard={dashboard}
                  refreshedAt={dashboardRefreshedAt}
                  refreshError={dashboardRefreshError}
                  refreshing={refreshing}
                  open={setModal}
                  defaultProject={defaultProject}
                  refresh={refresh}
                  flash={flash}
                />
              }
            />
            <Route
              path="/clients"
              element={
                <Clients
                  clients={clients}
                  projects={projects}
                  open={setModal}
                  refresh={refresh}
                  flash={flash}
                />
              }
            />
            <Route
              path="/clients/:id"
              element={<ClientDetail clients={clients} projects={projects} open={setModal} />}
            />
            <Route
              path="/projects"
              element={
                <Projects
                  projects={projects}
                  updateProjects={setProjects}
                  clients={clients}
                  tasks={tasks}
                  open={setModal}
                  refresh={refresh}
                  flash={flash}
                />
              }
            />
            <Route
              path="/projects/:id"
              element={
                <ProjectDetail
                  projects={projects}
                  tasks={tasks}
                  open={setModal}
                  remember={setLastProjectId}
                  refresh={refresh}
                  flash={flash}
                />
              }
            />
            <Route
              path="/kanban"
              element={
                <Kanban
                  tasks={tasks}
                  updateTasks={setTasks}
                  clients={clients}
                  projects={projects}
                  tags={tags}
                  open={setModal}
                  remember={setLastProjectId}
                  refresh={refresh}
                  flash={flash}
                />
              }
            />
            <Route
              path="/settings"
              element={
                <SettingsView
                  branding={branding}
                  tags={tags}
                  tasks={tasks}
                  refresh={refresh}
                  flash={flash}
                />
              }
            />
          </Routes>
        </div>
      </main>
      {modal && (
        <ModalHost
          modal={modal}
          clients={clients}
          projects={projects}
          tasks={tasks}
          tags={tags}
          close={() => setModal(null)}
          edit={(task) => setModal({ type: 'task', value: task })}
          saved={saved}
          refresh={refresh}
          flash={flash}
        />
      )}
      {notice && (
        <div className={`toast ${notice.tone}`} role="status">
          {notice.tone === 'success' ? <CheckCircle2 /> : <CircleAlert />}
          {notice.text}
        </div>
      )}
    </div>
  );
}

function Nav({
  icon,
  to,
  label,
  collapsed,
}: {
  icon: ReactNode;
  to: string;
  label: string;
  collapsed: boolean;
}) {
  return (
    <NavLink to={to} end={to === '/'} title={label}>
      {icon}
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}
function pageName(path: string) {
  if (path.startsWith('/clients')) return 'Clients';
  if (path.startsWith('/projects')) return 'Projects';
  if (path.startsWith('/kanban')) return 'Status';
  if (path.startsWith('/settings')) return 'Settings';
  return 'Dashboard';
}
function PageHead({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {action}
    </div>
  );
}

/** The three deadline states the Deadlines panel can show, and the board filter behind each. */
type DeadlineBucket = 'overdue' | 'today' | 'week';

function Dashboard({
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
    ['Due today', dashboard.counts.dueToday, <Clock3 />, '/kanban?filter=today'],
    ['Next 7 days', dashboard.counts.dueNextSevenDays, <CalendarDays />, '/kanban?filter=week'],
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
          <button className="secondary" onClick={() => nav(`/kanban?filter=${shown.boardFilter}`)}>
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
            <button className="text-btn" onClick={() => nav('/kanban')}>
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
          <button onClick={() => nav('/kanban')}>
            <FolderKanban />
            Open Status board
          </button>
        </div>
      </section>
    </>
  );
}

function Clients({
  clients,
  projects,
  open,
  refresh,
  flash,
}: {
  clients: Client[];
  projects: Project[];
  open: (m: Modal) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [query, setQuery] = useState('');
  const visible = clients.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const archive = async (c: Client) => {
    if (!confirm(`Archive ${c.name}? Its Drive folder and project history will remain intact.`))
      return;
    await send(`/clients/${c.id}/archive`, 'POST');
    await refresh();
    flash('Client archived.');
  };
  return (
    <>
      <PageHead
        eyebrow="Relationships"
        title="Clients"
        body="A clear view of every client, their work, and Drive connection."
        action={
          <button onClick={() => open({ type: 'client' })}>
            <Plus /> New client
          </button>
        }
      />
      <SearchBox value={query} set={setQuery} placeholder="Search clients…" />
      <div className="card-grid">
        {visible.map((c) => (
          <article className={`entity-card ${c.status === 'ARCHIVED' ? 'muted' : ''}`} key={c.id}>
            <div className="entity-top">
              <div className="monogram large">{initials(c.name)}</div>
              <DriveBadge status={c.driveStatus} />
            </div>
            <Link className="entity-title" to={`/clients/${c.id}`}>
              <h2>{c.name}</h2>
              <span>
                {projects.filter((p) => p.clientId === c.id && p.status !== 'ARCHIVED').length}{' '}
                active projects
              </span>
            </Link>
            <div className="entity-contact">
              {c.contactName && <span>{c.contactName}</span>}
              {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
            </div>
            <div className="card-actions">
              {c.driveFolderUrl ? (
                <a className="secondary" href={c.driveFolderUrl} target="_blank" rel="noreferrer">
                  Drive <ExternalLink />
                </a>
              ) : (
                <span />
              )}
              <button
                className="icon-btn"
                onClick={() => open({ type: 'client', value: c })}
                aria-label={`Edit ${c.name}`}
              >
                <Settings />
              </button>
              {c.status === 'ACTIVE' && (
                <button
                  className="icon-btn danger"
                  onClick={() => archive(c)}
                  aria-label={`Archive ${c.name}`}
                >
                  <Archive />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!visible.length && (
        <Empty
          title="No clients found"
          body={query ? 'Try a different search.' : 'Create your first client to begin.'}
          action={
            !query ? (
              <button onClick={() => open({ type: 'client' })}>
                <Plus /> New client
              </button>
            ) : undefined
          }
        />
      )}
    </>
  );
}

function ClientDetail({
  clients,
  projects,
  open,
}: {
  clients: Client[];
  projects: Project[];
  open: (m: Modal) => void;
}) {
  const { id } = useParams();
  const client = clients.find((c) => c.id === id);
  if (!client)
    return <Empty title="Client not found" body="This client may have been archived or removed." />;
  const mine = projects.filter((p) => p.clientId === id);
  return (
    <>
      <div className="backline">
        <Link to="/clients">← All clients</Link>
      </div>
      <PageHead
        eyebrow="Client portfolio"
        title={client.name}
        body={client.notes || 'Client details and every project in one place.'}
        action={
          <div className="head-actions">
            {client.driveFolderUrl && (
              <a
                className="secondary buttonlike"
                href={client.driveFolderUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Drive <ExternalLink />
              </a>
            )}
            <button onClick={() => open({ type: 'project', clientId: client.id })}>
              <Plus /> New project
            </button>
          </div>
        }
      />
      <div className="detail-grid">
        <section className="panel detail-info">
          <h2>Client information</h2>
          <dl>
            <dt>Contact</dt>
            <dd>{client.contactName || 'Not added'}</dd>
            <dt>Email</dt>
            <dd>{client.email || 'Not added'}</dd>
            <dt>Phone</dt>
            <dd>{client.phone || 'Not added'}</dd>
            <dt>Drive</dt>
            <dd>
              <DriveBadge status={client.driveStatus} />
              {client.driveError && <small>{client.driveError}</small>}
            </dd>
          </dl>
          <button className="secondary" onClick={() => open({ type: 'client', value: client })}>
            Edit details
          </button>
        </section>
        <section className="panel span2">
          <div className="section-title">
            <div>
              <span className="eyebrow">Portfolio</span>
              <h2>Projects</h2>
            </div>
          </div>
          {mine.length ? (
            <div className="project-table">
              {mine.map((p) => (
                <Link to={`/projects/${p.id}`} key={p.id}>
                  <span className="priority-stripe" data-priority={p.priority} />
                  <div>
                    <strong>{p.name}</strong>
                    <span>
                      {p.status.replace('_', ' ')} ·{' '}
                      {p.targetDeadline ? `Due ${formatDate(p.targetDeadline)}` : 'No deadline'}
                    </span>
                  </div>
                  <DriveBadge status={p.driveStatus} />
                  <ChevronRight />
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              compact
              title="No projects yet"
              body="Create the first project for this client."
            />
          )}
        </section>
      </div>
    </>
  );
}

type ProjectSort =
  | 'recently-updated'
  | 'recently-created'
  | 'name-ascending'
  | 'name-descending'
  | 'deadline'
  | 'priority'
  | 'custom';

const PROJECT_PRIORITY_ORDER: Record<Priority, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function projectComparator(sortBy: ProjectSort) {
  return (a: Project, b: Project) => {
    if (sortBy === 'recently-updated') return compareProjectActivity(a, b);
    if (sortBy === 'recently-created') {
      return b.createdAt.localeCompare(a.createdAt) || compareProjectNames(a, b);
    }
    if (sortBy === 'name-ascending') return compareProjectNames(a, b);
    if (sortBy === 'name-descending') return compareProjectNames(b, a);
    if (sortBy === 'deadline') {
      if (!a.targetDeadline) return b.targetDeadline ? 1 : compareProjectNames(a, b);
      if (!b.targetDeadline) return -1;
      return a.targetDeadline.localeCompare(b.targetDeadline) || compareProjectNames(a, b);
    }
    if (sortBy === 'priority') {
      return (
        PROJECT_PRIORITY_ORDER[a.priority] - PROJECT_PRIORITY_ORDER[b.priority] ||
        compareProjectNames(a, b)
      );
    }
    // Custom. Projects that have never been dragged all share position 0, so the sort
    // stays stable and they keep the order the API returned them in.
    if (sortBy === 'custom') return a.position - b.position;
    return 0;
  };
}

function Projects({
  projects,
  updateProjects,
  clients,
  tasks,
  open,
  refresh,
  flash,
}: {
  projects: Project[];
  updateProjects: (projects: Project[]) => void;
  clients: Client[];
  tasks: Task[];
  open: (m: Modal) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [query, setQuery] = useState(''),
    [clientFilter, setClientFilter] = useState(''),
    [sortBy, setSortBy] = useState<ProjectSort>('recently-updated');
  const visible = projects.filter(
    (p) =>
      (!clientFilter || p.clientId === clientFilter) &&
      `${p.name} ${p.clientName}`.toLowerCase().includes(query.toLowerCase()),
  );
  const sortedVisible = [...visible].sort(projectComparator(sortBy));
  // Manual order and a sort rule cannot both win, so dragging belongs to Custom alone.
  // Anywhere else a dropped tile would spring back to its sorted place and read as a bug.
  const rearrangeable = sortBy === 'custom';
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  /**
   * Moves `project` to where `overId` currently sits. Positions are rewritten across every
   * project, not just the filtered tiles, so reordering a search result cannot collide with
   * the positions of projects the filter is hiding.
   */
  const reorder = async (project: Project, overId: string) => {
    const oldIndex = projects.findIndex((p) => p.id === project.id);
    const newIndex = projects.findIndex((p) => p.id === overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const reordered = arrayMove(projects, oldIndex, newIndex).map((p, position) => ({
      ...p,
      position,
    }));
    updateProjects(reordered);
    try {
      await send('/projects/reorder', 'POST', { orderedIds: reordered.map((p) => p.id) });
      await refresh();
      flash('Project order saved.');
    } catch (e) {
      updateProjects(projects);
      flash((e as Error).message, 'error');
    }
  };
  const dragEnd = (event: DragEndEvent) => {
    if (!event.over || event.over.id === event.active.id) return;
    const project = projects.find((p) => p.id === event.active.id);
    if (project) reorder(project, String(event.over.id));
  };
  /** Keyboard equivalent of dropping a tile onto the tile currently at `nextIndex`. */
  const moveToIndex = (project: Project, nextIndex: number) => {
    const target = sortedVisible[nextIndex];
    if (target) reorder(project, target.id);
  };
  const archive = async (p: Project) => {
    if (!confirm(`Archive ${p.name}? Tasks and Drive files will be preserved.`)) return;
    await send(`/projects/${p.id}/archive`, 'POST');
    await refresh();
    flash('Project archived.');
  };
  const remove = async (p: Project) => {
    if (
      !confirm(
        `Delete project “${p.name}” from Command Center?\n\nThis removes the project and its tasks from the app only. Drive folders and files are not touched.`,
      )
    )
      return;
    try {
      await send(`/projects/${p.id}`, 'DELETE');
      await refresh();
      flash('Project deleted from Command Center. Drive files were left alone.');
    } catch (e) {
      flash((e as Error).message, 'error');
    }
  };
  return (
    <>
      <PageHead
        eyebrow="Workstreams"
        title="Projects"
        body="Track scope, deadlines, task health, and storage from one view. Projects are owned by Command Center — not by Drive folder names."
        action={
          <button onClick={() => open({ type: 'project' })}>
            <Plus /> New project
          </button>
        }
      />
      <div className="filterbar">
        <SearchBox value={query} set={setQuery} placeholder="Search projects…" />
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          aria-label="Filter by client"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as ProjectSort)}
          aria-label="Sort projects by"
        >
          <option value="recently-updated">Recently updated</option>
          <option value="recently-created">Recently created</option>
          <option value="name-ascending">Name A–Z</option>
          <option value="name-descending">Name Z–A</option>
          <option value="deadline">Deadline (soonest)</option>
          <option value="priority">Priority (highest)</option>
          <option value="custom">Custom order</option>
        </select>
      </div>
      <p className="filterbar-hint">
        {rearrangeable
          ? 'Drag a tile by its grip, or use its position selector, to arrange projects by hand.'
          : 'Switch to Custom order to arrange tiles by hand.'}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={dragEnd}>
        <SortableContext items={sortedVisible.map((p) => p.id)} strategy={rectSortingStrategy}>
          <div className="project-cards">
            {sortedVisible.map((p, index) => (
              <ProjectTile
                key={p.id}
                project={p}
                tasks={tasks}
                index={index}
                total={sortedVisible.length}
                rearrangeable={rearrangeable}
                open={open}
                archive={archive}
                remove={remove}
                moveToIndex={moveToIndex}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!visible.length && (
        <Empty title="No projects found" body="Adjust your filters or create a new project." />
      )}
    </>
  );
}

function ProjectTile({
  project,
  tasks,
  index,
  total,
  rearrangeable,
  open,
  archive,
  remove,
  moveToIndex,
}: {
  project: Project;
  tasks: Task[];
  index: number;
  total: number;
  rearrangeable: boolean;
  open: (m: Modal) => void;
  archive: (p: Project) => void;
  remove: (p: Project) => void;
  moveToIndex: (p: Project, nextIndex: number) => void;
}) {
  // Listeners sit on the grip alone. A tile is mostly a <Link>, and dragging the whole
  // surface would fight navigation.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    disabled: !rearrangeable,
  });
  const mine = tasks.filter((t) => t.projectId === project.id),
    done = mine.filter((t) => t.status === 'COMPLETE').length,
    over = mine.filter((t) => t.overdue).length;
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'dragging' : ''}
    >
      <div className="project-card-head">
        <span className="status-label">{project.status.replace('_', ' ')}</span>
        <DriveBadge status={project.driveStatus} />
      </div>
      <Link to={`/projects/${project.id}`}>
        <span className="client-name">{project.clientName}</span>
        <h2>{project.name}</h2>
        <p>{project.description || 'No project description yet.'}</p>
      </Link>
      <div className="progress">
        <div>
          <span>Task progress</span>
          <strong>
            {done}/{mine.length}
          </strong>
        </div>
        <div className="progress-track">
          <span style={{ width: `${mine.length ? (done / mine.length) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="project-meta">
        <span className={over ? 'overdue-text' : ''}>
          {over ? (
            <>
              <AlertCircle />
              {over} overdue
            </>
          ) : (
            <>
              <Check />
              On track
            </>
          )}
        </span>
        <span>
          <CalendarDays />
          {project.targetDeadline ? formatDate(project.targetDeadline) : 'No deadline'}
        </span>
      </div>
      <div className="card-actions">
        <Link className="secondary buttonlike" to={`/kanban?project=${project.id}`}>
          Open board
        </Link>
        <button
          className="icon-btn"
          onClick={() => open({ type: 'project', value: project })}
          aria-label={`Edit ${project.name}`}
        >
          <Settings />
        </button>
        {project.status !== 'ARCHIVED' && (
          <button
            className="icon-btn danger"
            onClick={() => archive(project)}
            aria-label={`Archive ${project.name}`}
          >
            <Archive />
          </button>
        )}
        <button
          className="icon-btn danger"
          onClick={() => remove(project)}
          aria-label={`Delete ${project.name}`}
        >
          <Trash2 />
        </button>
        <button
          className="drag-handle"
          {...attributes}
          {...listeners}
          disabled={!rearrangeable}
          aria-label={`Drag ${project.name}`}
          title={rearrangeable ? `Drag ${project.name}` : 'Switch to Custom order to rearrange'}
        >
          <GripVertical />
        </button>
      </div>
      <label className="keyboard-move">
        <span className="sr-only">{`Position of ${project.name}`}</span>
        <select
          value={index + 1}
          disabled={!rearrangeable}
          onChange={(e) => moveToIndex(project, Number(e.target.value) - 1)}
        >
          {Array.from({ length: total }, (_, slot) => (
            <option key={slot} value={slot + 1}>
              {`Position ${slot + 1} of ${total}`}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}

function ProjectDetail({
  projects,
  tasks,
  open,
  remember,
  refresh,
  flash,
}: {
  projects: Project[];
  tasks: Task[];
  open: (m: Modal) => void;
  remember: (id: string) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const { id } = useParams();
  const nav = useNavigate();
  const p = projects.find((x) => x.id === id);
  const projectId = p?.id;
  useEffect(() => {
    if (projectId) remember(projectId);
  }, [projectId, remember]);
  if (!p) return <Empty title="Project not found" body="Return to Projects to choose another." />;
  const mine = tasks.filter((t) => t.projectId === id);
  const remove = async () => {
    if (
      !confirm(
        `Delete project “${p.name}” from Command Center?\n\nThis removes the project and its tasks from the app only. Drive folders and files are not touched.`,
      )
    )
      return;
    try {
      await send(`/projects/${p.id}`, 'DELETE');
      await refresh();
      flash('Project deleted from Command Center. Drive files were left alone.');
      nav('/projects');
    } catch (e) {
      flash((e as Error).message, 'error');
    }
  };
  return (
    <>
      <div className="backline">
        <Link to="/projects">← All projects</Link>
      </div>
      <PageHead
        eyebrow={p.clientName || 'Project'}
        title={p.name}
        body={p.description || 'Project tasks, deadline, and Drive workspace.'}
        action={
          <div className="head-actions">
            {p.driveFolderUrl && (
              <a
                className="secondary buttonlike"
                href={p.driveFolderUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Drive <ExternalLink />
              </a>
            )}
            <button onClick={() => open({ type: 'task', projectId: p.id })}>
              <Plus /> New task
            </button>
          </div>
        }
      />
      <div className="project-summary">
        <div>
          <span>Status</span>
          <strong>{p.status.replace('_', ' ')}</strong>
        </div>
        <div>
          <span>Deadline</span>
          <strong>{p.targetDeadline ? formatDate(p.targetDeadline) : 'Not set'}</strong>
        </div>
        <div>
          <span>Priority</span>
          <strong>{p.priority}</strong>
        </div>
        <div>
          <span>Task health</span>
          <strong>{mine.filter((t) => t.overdue).length} overdue</strong>
        </div>
      </div>
      <div className="detail-actions">
        <Link className="buttonlike" to={`/kanban?project=${p.id}`}>
          Open project status <ArrowRight />
        </Link>
        <button className="secondary" onClick={() => open({ type: 'project', value: p })}>
          Edit project
        </button>
        <button className="secondary danger-outline" onClick={remove}>
          <Trash2 /> Delete project
        </button>
      </div>
      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">Execution</span>
            <h2>All project tasks</h2>
          </div>
        </div>
        {mine.length ? (
          <div className="task-table">
            {mine.map((t) => (
              <button key={t.id} onClick={() => open({ type: 'taskDetail', value: t })}>
                <StatusDot status={t.status} />
                <div>
                  <strong>{t.title}</strong>
                  <span>{STATUS_LABEL[t.status]}</span>
                </div>
                <PriorityBadge priority={t.priority} />
                <Due task={t} />
                <ChevronRight />
              </button>
            ))}
          </div>
        ) : (
          <Empty compact title="No tasks yet" body="Create a task to start planning the work." />
        )}
      </section>
    </>
  );
}

function Kanban({
  tasks,
  updateTasks,
  clients,
  projects,
  tags,
  open,
  remember,
  refresh,
  flash,
}: {
  tasks: Task[];
  updateTasks: (tasks: Task[]) => void;
  clients: Client[];
  projects: Project[];
  tags: Tag[];
  open: (m: Modal) => void;
  remember: (id: string) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [params, setParams] = useSearchParams();
  const project = params.get('project') || '',
    client = params.get('client') || '',
    flag = params.get('filter') || '';
  const [priority, setPriority] = useState('');
  const [query, setQuery] = useState('');
  // Tag selection lives in the URL beside the client and project filters, so a filtered board
  // survives a reload and can be handed to someone else as a link.
  const selectedTagIds = (params.get('tags') || '').split(',').filter(Boolean);
  useEffect(() => {
    if (project) remember(project);
  }, [project, remember]);
  const needle = query.trim().toLowerCase();
  const filtered = tasks.filter(
    (t) =>
      (!project || t.projectId === project) &&
      (!client || t.clientId === client) &&
      (!priority || t.priority === priority) &&
      // Every selected tag must be present, so each chip narrows the board the way the
      // selects above it do rather than widening it.
      selectedTagIds.every((tagId) => t.tags.some((tag) => tag.id === tagId)) &&
      (!needle ||
        t.title.toLowerCase().includes(needle) ||
        t.tags.some((tag) => tag.name.toLowerCase().includes(needle))) &&
      (!flag ||
        (flag === 'overdue' && t.overdue) ||
        (flag === 'blocked' && t.blocked) ||
        // The same rules the dashboard counts with, so a tile and the board it links to
        // can never show different sets.
        (flag === 'today' && isDueToday(t)) ||
        (flag === 'week' && isDueNextSevenDays(t)) ||
        (flag === 'none' && !t.dueDate) ||
        (flag === 'completed' && t.status === 'COMPLETE')),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const move = async (task: Task, status: TaskStatus, overId?: string | number) => {
    const destination = tasks.filter((candidate) => candidate.status === status);
    let reordered: Task[];
    if (task.status === status) {
      const oldIndex = destination.findIndex((candidate) => candidate.id === task.id);
      const overIndex = destination.findIndex((candidate) => candidate.id === overId);
      const newIndex = overIndex >= 0 ? overIndex : destination.length - 1;
      reordered = arrayMove(destination, oldIndex, newIndex);
    } else {
      const withoutTask = destination.filter((candidate) => candidate.id !== task.id);
      const overIndex = withoutTask.findIndex((candidate) => candidate.id === overId);
      const withTask = [...withoutTask, { ...task, status }];
      const newIndex = overIndex >= 0 ? overIndex : withTask.length - 1;
      reordered = arrayMove(withTask, withTask.length - 1, newIndex);
    }
    const orderedIds = reordered.map((candidate) => candidate.id);
    const optimisticTasks = TASK_STATUSES.flatMap((candidateStatus) =>
      candidateStatus === status
        ? reordered.map((candidate, position) => ({ ...candidate, position }))
        : tasks.filter(
            (candidate) => candidate.status === candidateStatus && candidate.id !== task.id,
          ),
    );
    updateTasks(optimisticTasks);

    try {
      await send('/tasks/reorder', 'POST', { taskId: task.id, status, orderedIds });
      await refresh();
      flash(
        task.status === status
          ? `Reordered in ${STATUS_LABEL[status]}.`
          : `Moved to ${STATUS_LABEL[status]}.`,
      );
    } catch (e: any) {
      if (e.status === 409 && e.data?.code === 'TASK_BLOCKED') {
        if (confirm(`${e.message}\n\nComplete anyway and override the dependency block?`)) {
          try {
            await send('/tasks/reorder', 'POST', {
              taskId: task.id,
              status,
              orderedIds,
              overrideBlocked: true,
            });
            await refresh();
            flash('Task completed with dependency override.');
          } catch (overrideError) {
            updateTasks(tasks);
            flash((overrideError as Error).message, 'error');
          }
        } else {
          updateTasks(tasks);
        }
      } else {
        updateTasks(tasks);
        flash(e.message, 'error');
      }
    }
  };
  const dragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const task = tasks.find((t) => t.id === event.active.id);
    if (!task) return;
    const overTask = tasks.find((t) => t.id === event.over!.id);
    const status = (
      TASK_STATUSES.includes(event.over.id as TaskStatus) ? event.over.id : overTask?.status
    ) as TaskStatus | undefined;
    if (status) move(task, status, event.over.id);
  };
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <>
      <PageHead
        eyebrow="Workflow"
        title="Project Status"
        body={`${filtered.length} visible tasks · move work forward with drag, touch, or keyboard controls.`}
        action={
          <button onClick={() => open({ type: 'task', projectId: project || undefined })}>
            <Plus /> New task
          </button>
        }
      />
      <div className="board-filters">
        <label>
          <span>Client</span>
          <select value={client} onChange={(e) => set('client', e.target.value)}>
            <option value="">All clients</option>
            {clients
              .filter((c) => c.status === 'ACTIVE')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>Project</span>
          <select value={project} onChange={(e) => set('project', e.target.value)}>
            <option value="">All projects</option>
            {projects
              .filter((p) => !client || p.clientId === client)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">Any priority</option>
            {['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Focus</span>
          <select value={flag} onChange={(e) => set('filter', e.target.value)}>
            <option value="">All tasks</option>
            <option value="overdue">Overdue</option>
            <option value="today">Due today</option>
            <option value="week">Due this week</option>
            <option value="none">No due date</option>
            <option value="blocked">Blocked</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      </div>
      <SearchBox value={query} set={setQuery} placeholder="Search task titles and tags…" />
      {tags.length > 0 && (
        <div className="tag-filter">
          <span className="tag-filter-label" id="tag-filter-label">
            <TagIcon /> Tags
          </span>
          <div role="group" aria-labelledby="tag-filter-label">
            {tags.map((tag) => {
              const active = selectedTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`tag-chip toggle ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  style={{ borderColor: tagAccent(tag) }}
                  onClick={() =>
                    set(
                      'tags',
                      (active
                        ? selectedTagIds.filter((tagId) => tagId !== tag.id)
                        : [...selectedTagIds, tag.id]
                      ).join(','),
                    )
                  }
                >
                  <span className="tag-dot" style={{ background: tagAccent(tag) }} />
                  {tag.name}
                </button>
              );
            })}
          </div>
          {selectedTagIds.length > 0 && (
            <button type="button" className="text-btn" onClick={() => set('tags', '')}>
              Clear tags
            </button>
          )}
        </div>
      )}
      {selectedTagIds.length > 1 && (
        <p className="filterbar-hint">Showing tasks that carry every selected tag.</p>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={dragEnd}>
        <div className="kanban-board">
          {TASK_STATUSES.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={filtered.filter((t) => t.status === status)}
              open={open}
              move={move}
            />
          ))}
        </div>
      </DndContext>
    </>
  );
}
function KanbanColumn({
  status,
  tasks,
  open,
  move,
}: {
  status: TaskStatus;
  tasks: Task[];
  open: (m: Modal) => void;
  move: (t: Task, s: TaskStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section ref={setNodeRef} className={`kanban-column ${isOver ? 'drop-active' : ''}`}>
      <header>
        <div>
          <span className={`status-dot ${status.toLowerCase()}`} />
          <h2>{STATUS_LABEL[status]}</h2>
          <span className="count">{tasks.length}</span>
        </div>
        <p>{STATUS_HELP[status]}</p>
      </header>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="column-body">
          {tasks.map((t) => (
            <KanbanCard key={t.id} task={t} open={open} move={move} />
          ))}
          {!tasks.length && <div className="column-empty">Drop tasks here</div>}
        </div>
      </SortableContext>
    </section>
  );
}
function KanbanCard({
  task,
  open,
  move,
}: {
  task: Task;
  open: (m: Modal) => void;
  move: (t: Task, s: TaskStatus) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`kanban-card ${isDragging ? 'dragging' : ''} ${task.overdue ? 'is-overdue' : ''} ${task.blocked ? 'is-blocked' : ''}`}
    >
      <div className="card-labels">
        <PriorityBadge priority={task.priority} />
        {task.taskType && <TaskTypeBadge type={task.taskType} />}
        {task.blocked && (
          <span className="blocked-label">
            <ShieldAlert /> Blocked
          </span>
        )}
        {task.overdue && (
          <span className="overdue-label">
            <AlertCircle /> Overdue
          </span>
        )}
      </div>
      <button className="card-title" onClick={() => open({ type: 'taskDetail', value: task })}>
        <strong>{task.title}</strong>
        <span>
          {task.clientName} · {task.projectName}
        </span>
      </button>
      {task.tags.length > 0 && (
        <ul className="tag-list" aria-label={`Tags on ${task.title}`}>
          {task.tags.map((tag) => (
            <li key={tag.id}>
              <TagChip tag={tag} />
            </li>
          ))}
        </ul>
      )}
      {task.description && <p>{task.description}</p>}
      <div className="card-foot">
        <Due task={task} />
        {task.checklistTotal > 0 && (
          <span>
            <ListChecks />
            {task.checklistCompleted}/{task.checklistTotal}
          </span>
        )}
        <button
          className="drag-handle"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${task.title}`}
        >
          <GripVertical />
        </button>
      </div>
      <label className="keyboard-move">
        <span className="sr-only">Move task status</span>
        <select value={task.status} onChange={(e) => move(task, e.target.value as TaskStatus)}>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}

function SettingsView({
  branding,
  tags,
  tasks,
  refresh,
  flash,
}: {
  branding: Branding;
  tags: Tag[];
  tasks: Task[];
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [state, setState] = useState<{
      configured: boolean;
      connected: boolean;
      rootFolderId?: string;
      rootFolderUrl?: string;
    } | null>(null),
    [root, setRoot] = useState(''),
    [brandForm, setBrandForm] = useState<Branding>(branding),
    [brandBusy, setBrandBusy] = useState(false);
  const load = useCallback(() => api<any>('/settings/drive').then(setState), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    setBrandForm(branding);
  }, [branding]);
  const connect = async () => {
    try {
      const { url } = await api<{ url: string }>('/drive/oauth/start');
      window.location.href = url;
    } catch (e) {
      flash((e as Error).message, 'error');
    }
  };
  const saveRoot = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await send('/settings/drive/root', 'POST', { folderId: root });
      await load();
      await refresh();
      flash('Command Center root folder saved.');
    } catch (err) {
      flash((err as Error).message, 'error');
    }
  };
  const disconnect = async () => {
    if (
      !confirm(
        'Disconnect Google Drive? Local project data will remain, and no Drive files will be deleted.',
      )
    )
      return;
    await send('/settings/drive/disconnect', 'POST');
    await load();
    flash('Google Drive disconnected.');
  };
  const saveBranding = async (e: FormEvent) => {
    e.preventDefault();
    setBrandBusy(true);
    try {
      await send('/settings/branding', 'PUT', brandForm);
      await refresh();
      flash('Sidebar branding saved.');
    } catch (err) {
      flash((err as Error).message, 'error');
    } finally {
      setBrandBusy(false);
    }
  };
  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Settings"
        body="Connect storage, shape the sidebar brand, and control how this local command center behaves."
      />
      <div className="settings-layout">
        <section className="panel settings-card">
          <div className="settings-icon">
            <ExternalLink />
          </div>
          <div className="section-title">
            <div>
              <span className="eyebrow">Integration</span>
              <h2>Google Drive</h2>
            </div>
            <DriveBadge status={state?.connected ? 'CONNECTED' : 'DISCONNECTED'} />
          </div>
          <p>
            Drive stores project files. Clients and projects are owned by Command Center — folder
            names never create projects. OAuth tokens stay encrypted locally and never reach the
            browser.
          </p>
          {!state?.configured && (
            <div className="inline-warning">
              <AlertCircle />
              <div>
                <strong>Credentials required</strong>
                <span>
                  Add the Google OAuth values and encryption key from <code>.env.example</code>,
                  then restart the app.
                </span>
              </div>
            </div>
          )}
          {state?.connected ? (
            <>
              <form onSubmit={saveRoot} className="root-form">
                <label>
                  Command Center root folder URL or ID
                  <input
                    value={root}
                    onChange={(e) => setRoot(e.target.value)}
                    placeholder={state.rootFolderId || 'Paste a Google Drive folder URL'}
                    required
                  />
                </label>
                <button type="submit">Verify & save root</button>
              </form>
              {state.rootFolderUrl && (
                <a
                  className="drive-root"
                  target="_blank"
                  rel="noreferrer"
                  href={state.rootFolderUrl}
                >
                  <div>
                    <FolderKanban />
                    <span>
                      <strong>Current root folder</strong>
                      <small>{state.rootFolderId}</small>
                    </span>
                  </div>
                  <ExternalLink />
                </a>
              )}
              <button className="text-btn danger-text" onClick={disconnect}>
                Disconnect Google Drive
              </button>
            </>
          ) : (
            <button onClick={connect} disabled={!state?.configured}>
              Connect Google Drive
            </button>
          )}
        </section>
        <section className="panel settings-card">
          <div className="settings-icon neutral">
            <Pencil />
          </div>
          <div className="section-title">
            <div>
              <span className="eyebrow">Sidebar</span>
              <h2>Branding</h2>
            </div>
            <span className="version-pill">v{APP_VERSION}</span>
          </div>
          <p>
            Edit the mark, title, and tagline shown in the sidebar. Defaults also live in{' '}
            <code>shared/branding.ts</code> if you prefer changing them in code.
          </p>
          <form className="form brand-form" onSubmit={saveBranding}>
            <div className="form-row">
              <label>
                Mark
                <input
                  value={brandForm.mark}
                  maxLength={4}
                  onChange={(e) => setBrandForm({ ...brandForm, mark: e.target.value })}
                  required
                />
              </label>
              <label>
                Title
                <input
                  value={brandForm.title}
                  maxLength={40}
                  onChange={(e) => setBrandForm({ ...brandForm, title: e.target.value })}
                  required
                />
              </label>
            </div>
            <label>
              Subtitle
              <input
                value={brandForm.subtitle}
                maxLength={60}
                onChange={(e) => setBrandForm({ ...brandForm, subtitle: e.target.value })}
                required
              />
            </label>
            <label>
              Tagline
              <input
                value={brandForm.tagline}
                maxLength={80}
                onChange={(e) => setBrandForm({ ...brandForm, tagline: e.target.value })}
                required
              />
            </label>
            <div className="brand-preview">
              <div className="brand-mark">{brandForm.mark || 'HC'}</div>
              <div>
                <strong>{brandForm.title || 'Hybrid'}</strong>
                <span>{brandForm.subtitle || 'Command Center'}</span>
              </div>
            </div>
            <button className="submit" disabled={brandBusy}>
              {brandBusy ? (
                <>
                  <RefreshCw className="spin" /> Saving…
                </>
              ) : (
                'Save branding'
              )}
            </button>
          </form>
        </section>
        <TagsCard tags={tags} tasks={tasks} refresh={refresh} flash={flash} />
        <section className="panel settings-card">
          <div className="settings-icon neutral">
            <Clock3 />
          </div>
          <div className="section-title">
            <div>
              <span className="eyebrow">Dates & deadlines</span>
              <h2>Local timezone</h2>
            </div>
          </div>
          <p>
            Deadlines are interpreted at the end of each date in your current browser timezone.
            Stored timestamps use UTC for consistency.
          </p>
          <div className="timezone">
            <span>Detected timezone</span>
            <strong>{Intl.DateTimeFormat().resolvedOptions().timeZone}</strong>
          </div>
        </section>
        <section className="panel settings-card">
          <div className="settings-icon neutral">
            <FileText />
          </div>
          <div className="section-title">
            <div>
              <span className="eyebrow">Future modules</span>
              <h2>Calendar, files & import</h2>
            </div>
          </div>
          <p>
            Route and service extension points are reserved. These modules can be added without
            changing current task or project data.
          </p>
          <div className="future-list">
            <span>
              <CalendarDays /> Calendar views
            </span>
            <span>
              <FileText /> Embedded Drive browser
            </span>
            <span>
              <Upload /> Campaign playbook import
            </span>
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * Global tag list with the only destructive tag action in the app. Deleting a tag that is
 * still attached is a two-step flow: the first call is refused with `TAG_IN_USE` and the
 * server's own count, which is what the confirmation quotes before the confirmed call goes
 * out. The count is read from that response rather than from `tasks`, so what the user
 * confirms is what the server is about to detach.
 */
function TagsCard({
  tags,
  tasks,
  refresh,
  flash,
}: {
  tags: Tag[];
  tasks: Task[];
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const usage = (tag: Tag) => tasks.filter((t) => t.tags.some((x) => x.id === tag.id)).length;
  const remove = async (tag: Tag) => {
    try {
      await send(`/tags/${tag.id}`, 'DELETE');
      await refresh();
      flash(`Tag “${tag.name}” deleted.`);
    } catch (error: any) {
      if (error.status !== 409 || error.data?.code !== 'TAG_IN_USE')
        return flash(error.message, 'error');
      const count: number = error.data.attachedTaskCount;
      const tasksWord = `${count} task${count === 1 ? '' : 's'}`;
      if (
        !confirm(
          `“${tag.name}” is attached to ${tasksWord}.\n\nDelete the tag and remove it from ${count === 1 ? 'that task' : 'those tasks'}? The ${count === 1 ? 'task itself is' : 'tasks themselves are'} not deleted.`,
        )
      )
        return;
      try {
        await send(`/tags/${tag.id}?confirm=true`, 'DELETE');
        await refresh();
        flash(`Tag “${tag.name}” deleted from ${tasksWord}.`);
      } catch (confirmed) {
        flash((confirmed as Error).message, 'error');
      }
    }
  };
  return (
    <section className="panel settings-card">
      <div className="settings-icon neutral">
        <TagIcon />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Labels</span>
          <h2>Task tags</h2>
        </div>
        <span className="version-pill">{tags.length}</span>
      </div>
      <p>
        Tags are shared by every task. Add one from a task’s details to create it; deleting one here
        removes it from every task that carries it, and never deletes a task.
      </p>
      {tags.length ? (
        <ul className="tag-manager">
          {tags.map((tag) => (
            <li key={tag.id}>
              <TagChip tag={tag} />
              <span>
                {usage(tag)} task{usage(tag) === 1 ? '' : 's'}
              </span>
              <button
                className="icon-btn danger"
                onClick={() => remove(tag)}
                aria-label={`Delete tag ${tag.name}`}
              >
                <Trash2 />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty compact title="No tags yet" body="Tag a task to start building the shared list." />
      )}
    </section>
  );
}

function ModalHost({
  modal,
  clients,
  projects,
  tasks,
  tags,
  close,
  edit,
  saved,
  refresh,
  flash,
}: {
  modal: NonNullable<Modal>;
  clients: Client[];
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  close: () => void;
  /** Swaps the detail view for the full edit form. */
  edit: (task: Task) => void;
  saved: (s: string) => Promise<void>;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  if (modal.type === 'client')
    return (
      <EntityModal title={modal.value ? 'Edit client' : 'New client'} close={close}>
        <ClientForm value={modal.value} saved={saved} />
      </EntityModal>
    );
  if (modal.type === 'project')
    return (
      <EntityModal title={modal.value ? 'Edit project' : 'New project'} close={close}>
        <ProjectForm
          value={modal.value}
          defaultClient={modal.clientId}
          clients={clients}
          saved={saved}
        />
      </EntityModal>
    );
  if (modal.type === 'task')
    return (
      <EntityModal title={modal.value ? 'Edit task' : 'New task'} close={close}>
        <TaskForm
          value={modal.value}
          defaultProject={modal.projectId}
          projects={projects}
          tags={tags}
          saved={saved}
        />
      </EntityModal>
    );
  const task = tasks.find((t) => t.id === modal.value.id) || modal.value;
  return (
    <EntityModal title="Task details" wide close={close}>
      <TaskDetail
        task={task}
        tasks={tasks}
        tags={tags}
        close={close}
        edit={() => edit(task)}
        refresh={refresh}
        flash={flash}
      />
    </EntityModal>
  );
}
function EntityModal({
  title,
  close,
  children,
  wide,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <div>
            <span className="eyebrow">Command Center</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ClientForm({ value, saved }: { value?: Client; saved: (s: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await send(value ? `/clients/${value.id}` : '/clients', value ? 'PATCH' : 'POST', data);
      await saved(
        value ? 'Client updated.' : 'Client created. Drive setup is continuing in the background.',
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <Field label="Client name" name="name" value={value?.name} required />
      <div className="form-row">
        <Field label="Contact name" name="contactName" value={value?.contactName} />
        <Field label="Email" name="email" type="email" value={value?.email} />
      </div>
      <div className="form-row">
        <Field label="Phone" name="phone" value={value?.phone} />
        <Field label="Website" name="website" type="url" value={value?.website} />
      </div>
      <TextArea label="Notes" name="notes" value={value?.notes} />
      <FormEnd error={error} busy={busy} label={value ? 'Save changes' : 'Create client'} />
    </form>
  );
}
function ProjectForm({
  value,
  defaultClient,
  clients,
  saved,
}: {
  value?: Project;
  defaultClient?: string;
  clients: Client[];
  saved: (s: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await send(value ? `/projects/${value.id}` : '/projects', value ? 'PATCH' : 'POST', data);
      await saved(
        value ? 'Project updated.' : 'Project created. Drive folders are being prepared.',
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Client
        <select name="clientId" defaultValue={value?.clientId || defaultClient || ''} required>
          <option value="" disabled>
            Select a client
          </option>
          {clients
            .filter((c) => c.status === 'ACTIVE' || c.id === value?.clientId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <Field label="Project name" name="name" value={value?.name} required />
      <TextArea label="Description" name="description" value={value?.description} />
      <div className="form-row">
        <Select
          label="Status"
          name="status"
          value={value?.status || 'ACTIVE'}
          options={['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETE']}
        />
        <Select
          label="Priority"
          name="priority"
          value={value?.priority || 'MEDIUM'}
          options={['LOW', 'MEDIUM', 'HIGH', 'URGENT']}
        />
      </div>
      <div className="form-row">
        <Field
          label="Start date"
          name="startDate"
          type="date"
          value={dateInput(value?.startDate)}
        />
        <Field
          label="Target deadline"
          name="targetDeadline"
          type="date"
          value={dateInput(value?.targetDeadline)}
        />
      </div>
      <TextArea label="Notes" name="notes" value={value?.notes} />
      <FormEnd error={error} busy={busy} label={value ? 'Save changes' : 'Create project'} />
    </form>
  );
}
function TaskForm({
  value,
  defaultProject,
  projects,
  tags,
  saved,
}: {
  value?: Task;
  defaultProject?: string;
  projects: Project[];
  tags: Tag[];
  saved: (s: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // Tags are the one field FormData cannot carry: they are a multi-value list resolved
  // against the global tag table, so they are held in state and reconciled after the save.
  const [chosen, setChosen] = useState<TagDraft[]>(value?.tags ?? []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const task = await send<Task>(
        value ? `/tasks/${value.id}` : '/tasks',
        value ? 'PATCH' : 'POST',
        data,
      );
      await syncTaskTags(task.id, chosen, value?.tags ?? []);
      await saved(value ? 'Task updated.' : 'Task added to the board.');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Project
        <select name="projectId" defaultValue={value?.projectId || defaultProject || ''} required>
          <option value="" disabled>
            Select a project
          </option>
          {projects
            .filter((p) => p.status !== 'ARCHIVED')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.clientName} — {p.name}
              </option>
            ))}
        </select>
      </label>
      <Field label="Task title" name="title" value={value?.title} required />
      <TextArea label="Description" name="description" value={value?.description} />
      <div className="form-row triple">
        <Select
          label="Status"
          name="status"
          value={value?.status || 'BACKLOG'}
          options={TASK_STATUSES}
        />
        <Select
          label="Priority"
          name="priority"
          value={value?.priority || 'MEDIUM'}
          options={['LOW', 'MEDIUM', 'HIGH', 'URGENT']}
        />
        <Select
          label="Type"
          name="taskType"
          value={value?.taskType || ''}
          options={TASK_TYPES}
          labels={TASK_TYPE_LABEL}
          placeholder="No type"
        />
      </div>
      <div className="form-row">
        <Field
          label="Start date"
          name="startDate"
          type="date"
          value={dateInput(value?.startDate)}
        />
        <Field label="Due date" name="dueDate" type="date" value={dateInput(value?.dueDate)} />
      </div>
      <TagChipInput label="Tags" chosen={chosen} available={tags} onChange={setChosen} />
      <TextArea label="Notes" name="notes" value={value?.notes} />
      <FormEnd error={error} busy={busy} label={value ? 'Save changes' : 'Create task'} />
    </form>
  );
}

function TaskDetail({
  task,
  tasks,
  tags,
  close,
  edit,
  refresh,
  flash,
}: {
  task: Task;
  tasks: Task[];
  tags: Tag[];
  close: () => void;
  edit: () => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [text, setText] = useState(''),
    [dep, setDep] = useState(''),
    [renaming, setRenaming] = useState(false),
    [title, setTitle] = useState(task.title),
    [editingDescription, setEditingDescription] = useState(false),
    [description, setDescription] = useState(task.description ?? ''),
    [editingDue, setEditingDue] = useState(false),
    [dueDate, setDueDate] = useState(dateInput(task.dueDate)),
    [editingStart, setEditingStart] = useState(false),
    [startDate, setStartDate] = useState(dateInput(task.startDate)),
    [editingNotes, setEditingNotes] = useState(false),
    [notes, setNotes] = useState(task.notes ?? '');
  useEffect(() => {
    setTitle(task.title);
    setRenaming(false);
  }, [task.id, task.title]);
  // Saving one field refreshes the task; resetting only on id keeps other editors open.
  useEffect(() => {
    setDescription(task.description ?? '');
    setEditingDescription(false);
    setDueDate(dateInput(task.dueDate));
    setEditingDue(false);
    setStartDate(dateInput(task.startDate));
    setEditingStart(false);
    setNotes(task.notes ?? '');
    setEditingNotes(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the open task changes
  }, [task.id]);
  const mutate = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
      await refresh();
      flash(message);
      return true;
    } catch (e) {
      flash((e as Error).message, 'error');
      return false;
    }
  };
  const patchField = async (body: Record<string, string>, message: string, done: () => void) => {
    if (await mutate(() => send(`/tasks/${task.id}`, 'PATCH', body), message)) done();
  };
  const saveDescription = () => {
    const next = description.trim();
    if (next === (task.description ?? '').trim()) {
      setEditingDescription(false);
      setDescription(task.description ?? '');
      return;
    }
    void patchField({ description: next }, 'Description updated.', () =>
      setEditingDescription(false),
    );
  };
  const saveDue = () => {
    const next = dueDate;
    if (next === dateInput(task.dueDate)) {
      setEditingDue(false);
      return;
    }
    void patchField({ dueDate: next }, 'Due date updated.', () => setEditingDue(false));
  };
  const saveStart = () => {
    const next = startDate;
    if (next === dateInput(task.startDate)) {
      setEditingStart(false);
      return;
    }
    void patchField({ startDate: next }, 'Start date updated.', () => setEditingStart(false));
  };
  const saveNotes = () => {
    const next = notes.trim();
    if (next === (task.notes ?? '').trim()) {
      setEditingNotes(false);
      setNotes(task.notes ?? '');
      return;
    }
    void patchField({ notes: next }, 'Notes updated.', () => setEditingNotes(false));
  };
  const complete = async () => {
    try {
      await send(`/tasks/${task.id}`, 'PATCH', { status: 'COMPLETE' });
      await refresh();
      flash('Task completed.');
      close();
    } catch (e: any) {
      if (e.status === 409 && confirm(`${e.message}\n\nOverride the block and complete anyway?`)) {
        await send(`/tasks/${task.id}`, 'PATCH', { status: 'COMPLETE', overrideBlocked: true });
        await refresh();
        flash('Task completed with override.');
        close();
      } else flash(e.message, 'error');
    }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const next = title.trim();
    if (!next || next === task.title) {
      setRenaming(false);
      setTitle(task.title);
      return;
    }
    try {
      await send(`/tasks/${task.id}`, 'PATCH', { title: next });
      await refresh();
      setRenaming(false);
      flash('Task renamed.');
    } catch (err) {
      flash((err as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (
      !confirm(
        `Delete task “${task.title}”?\n\nThis removes the task from Command Center only. Drive folders and files are not touched.`,
      )
    )
      return;
    try {
      await send(`/tasks/${task.id}`, 'DELETE');
      await refresh();
      flash('Task deleted from Command Center. Drive files were left alone.');
      close();
    } catch (err) {
      flash((err as Error).message, 'error');
    }
  };
  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <div className="card-labels">
          <PriorityBadge priority={task.priority} />
          {task.taskType && <TaskTypeBadge type={task.taskType} />}
          {task.blocked && (
            <span className="blocked-label">
              <ShieldAlert /> Blocked
            </span>
          )}
          {task.overdue && (
            <span className="overdue-label">
              <AlertCircle /> Overdue
            </span>
          )}
        </div>
        {renaming ? (
          <form className="rename-form" onSubmit={rename}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              aria-label="Task title"
            />
            <button type="submit">
              <Check /> Save
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRenaming(false);
                setTitle(task.title);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="title-row">
            <h3>{task.title}</h3>
            <button className="icon-btn" onClick={() => setRenaming(true)} aria-label="Rename task">
              <Pencil />
            </button>
          </div>
        )}
        <span>
          {task.clientName} · {task.projectName}
        </span>
        <InlineTextEditor
          label="Description"
          value={task.description}
          emptyLabel="Add a description"
          editLabel="Edit description"
          editing={editingDescription}
          draft={description}
          onDraftChange={setDescription}
          onEdit={() => {
            setDescription(task.description ?? '');
            setEditingDescription(true);
          }}
          onCancel={() => {
            setDescription(task.description ?? '');
            setEditingDescription(false);
          }}
          onSave={saveDescription}
        />
        <div className="detail-chips">
          <span>
            <FolderKanban />
            {STATUS_LABEL[task.status]}
          </span>
          <InlineDateChip
            label="Due date"
            display={
              task.dueDate ? `${task.overdue ? 'Due ' : ''}${formatDate(task.dueDate)}` : 'No date'
            }
            editLabel={task.dueDate ? 'Edit due date' : 'Add due date'}
            editing={editingDue}
            draft={dueDate}
            muted={!task.dueDate}
            overdue={task.overdue}
            onDraftChange={setDueDate}
            onEdit={() => {
              setDueDate(dateInput(task.dueDate));
              setEditingDue(true);
            }}
            onCancel={() => {
              setDueDate(dateInput(task.dueDate));
              setEditingDue(false);
            }}
            onSave={saveDue}
          />
          <InlineDateChip
            label="Start date"
            display={task.startDate ? formatDate(task.startDate) : 'No start date'}
            editLabel={task.startDate ? 'Edit start date' : 'Add start date'}
            editing={editingStart}
            draft={startDate}
            muted={!task.startDate}
            onDraftChange={setStartDate}
            onEdit={() => {
              setStartDate(dateInput(task.startDate));
              setEditingStart(true);
            }}
            onCancel={() => {
              setStartDate(dateInput(task.startDate));
              setEditingStart(false);
            }}
            onSave={saveStart}
          />
        </div>
      </div>
      {task.blocked && (
        <div className="inline-warning blocked">
          <ShieldAlert />
          <div>
            <strong>
              Waiting on {task.blockingDependencies.length} task
              {task.blockingDependencies.length === 1 ? '' : 's'}
            </strong>
            <span>{task.blockingDependencies.map((d) => d.title).join(', ')}</span>
          </div>
        </div>
      )}
      <section>
        <div className="section-title">
          <div>
            <span className="eyebrow">Labels</span>
            <h2>Tags</h2>
          </div>
        </div>
        <TagChipInput
          label="Tags"
          chosen={task.tags}
          available={tags}
          onChange={(next) => mutate(() => syncTaskTags(task.id, next, task.tags), 'Tags updated.')}
        />
      </section>
      <section>
        <div className="section-title">
          <div>
            <span className="eyebrow">Progress</span>
            <h2>
              Checklist{' '}
              <small>
                {task.checklistCompleted}/{task.checklistTotal}
              </small>
            </h2>
          </div>
        </div>
        <div className="checklist">
          {task.checklist.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={item.completed}
                onChange={() =>
                  mutate(
                    () => send(`/checklist/${item.id}`, 'PATCH', { completed: !item.completed }),
                    'Checklist updated.',
                  )
                }
              />
              <span>{item.text}</span>
              <button
                type="button"
                onClick={() =>
                  mutate(() => send(`/checklist/${item.id}`, 'DELETE'), 'Checklist item removed.')
                }
                aria-label={`Delete ${item.text}`}
              >
                <X />
              </button>
            </label>
          ))}
        </div>
        <form
          className="inline-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            mutate(
              () => send(`/tasks/${task.id}/checklist`, 'POST', { text }),
              'Checklist item added.',
            );
            setText('');
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a checklist item"
          />
          <button>
            <Plus /> Add
          </button>
        </form>
      </section>
      <section>
        <div className="section-title">
          <div>
            <span className="eyebrow">Private</span>
            <h2>Notes</h2>
          </div>
        </div>
        <InlineTextEditor
          label="Notes"
          value={task.notes}
          emptyLabel="Add notes"
          editLabel="Edit notes"
          editing={editingNotes}
          draft={notes}
          onDraftChange={setNotes}
          onEdit={() => {
            setNotes(task.notes ?? '');
            setEditingNotes(true);
          }}
          onCancel={() => {
            setNotes(task.notes ?? '');
            setEditingNotes(false);
          }}
          onSave={saveNotes}
        />
      </section>
      <section>
        <div className="section-title">
          <div>
            <span className="eyebrow">Sequencing</span>
            <h2>Dependencies</h2>
          </div>
        </div>
        {task.dependencyIds.length > 0 && (
          <div className="dependency-list">
            {task.dependencyIds.map((depId) => {
              const d = tasks.find((t) => t.id === depId);
              return (
                d && (
                  <div key={depId}>
                    <StatusDot status={d.status} />
                    <span>{d.title}</span>
                    <button
                      onClick={() =>
                        mutate(
                          () => send(`/tasks/${task.id}/dependencies/${depId}`, 'DELETE'),
                          'Dependency removed.',
                        )
                      }
                      aria-label={`Remove ${d.title}`}
                    >
                      <X />
                    </button>
                  </div>
                )
              );
            })}
          </div>
        )}
        <form
          className="inline-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dep) return;
            mutate(
              () => send(`/tasks/${task.id}/dependencies`, 'POST', { dependencyId: dep }),
              'Dependency added.',
            );
            setDep('');
          }}
        >
          <select value={dep} onChange={(e) => setDep(e.target.value)}>
            <option value="">Choose a task…</option>
            {tasks
              .filter((t) => t.id !== task.id && !task.dependencyIds.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.projectName} — {t.title}
                </option>
              ))}
          </select>
          <button disabled={!dep}>
            <Plus /> Add
          </button>
        </form>
      </section>
      <footer>
        <button className="secondary danger-outline" onClick={remove}>
          <Trash2 /> Delete task
        </button>
        <button className="secondary" onClick={edit}>
          <Pencil /> Edit details
        </button>
        {task.status !== 'COMPLETE' && (
          <button onClick={complete}>
            <Check /> Mark complete
          </button>
        )}
        <button className="secondary" onClick={close}>
          Close
        </button>
      </footer>
    </div>
  );
}

function escapeCancels(cancel: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
}

function InlineTextEditor({
  label,
  value,
  emptyLabel,
  editLabel,
  editing,
  draft,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
}: {
  label: string;
  value?: string;
  emptyLabel: string;
  editLabel: string;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (editing)
    return (
      <form
        className="inline-edit"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        onKeyDown={escapeCancels(onCancel)}
      >
        <label>
          {label}
          <textarea value={draft} onChange={(e) => onDraftChange(e.target.value)} autoFocus />
        </label>
        <div className="inline-edit-actions">
          <button type="submit">
            <Check /> Save
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    );
  if (value)
    return (
      <div className="inline-field">
        <p>{value}</p>
        <button type="button" className="icon-btn" onClick={onEdit} aria-label={editLabel}>
          <Pencil />
        </button>
      </div>
    );
  return (
    <button type="button" className="text-btn inline-empty" onClick={onEdit}>
      {emptyLabel}
    </button>
  );
}

function InlineDateChip({
  label,
  display,
  editLabel,
  editing,
  draft,
  muted,
  overdue,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
}: {
  label: string;
  display: string;
  editLabel: string;
  editing: boolean;
  draft: string;
  muted?: boolean;
  overdue?: boolean;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (editing)
    return (
      <form
        className="chip-edit-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        onKeyDown={escapeCancels(onCancel)}
      >
        <label>
          {label}
          <input
            type="date"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            autoFocus
          />
        </label>
        <button type="submit">
          <Check /> Save
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </form>
    );
  return (
    <button
      type="button"
      className={`chip-toggle${muted ? ' muted' : ''}${overdue ? ' overdue-text' : ''}`}
      onClick={onEdit}
      aria-label={editLabel}
    >
      <CalendarDays />
      {display}
    </button>
  );
}

function Field({
  label,
  name,
  value,
  type = 'text',
  required,
}: {
  label: string;
  name: string;
  value?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} defaultValue={value || ''} required={required} />
    </label>
  );
}
function TextArea({ label, name, value }: { label: string; name: string; value?: string }) {
  return (
    <label>
      {label}
      <textarea name={name} defaultValue={value || ''} rows={3} />
    </label>
  );
}
function Select({
  label,
  name,
  value,
  options,
  labels,
  placeholder,
}: {
  label: string;
  name: string;
  value: string;
  options: readonly string[];
  /** Display text per option. Falls back to the raw value with underscores spaced out. */
  labels?: Record<string, string>;
  /** Leading empty-value option, for a field that may legitimately be left unset. */
  placeholder?: string;
}) {
  return (
    <label>
      {label}
      <select name={name} defaultValue={value}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}
/**
 * Reconciles a task's tags to `next`, creating any tag that does not exist yet. `POST /tags`
 * answers with the existing row when the normalized name already exists, so a name re-entered
 * in another case or with extra spaces attaches the tag already in use instead of a duplicate.
 * Detaches run before attaches so a task never briefly holds both sides of a swap.
 */
async function syncTaskTags(taskId: string, next: TagDraft[], previous: Tag[]) {
  const resolved: Tag[] = [];
  for (const draft of next)
    resolved.push(
      draft.id
        ? { id: draft.id, name: draft.name, color: draft.color }
        : await send<Tag>('/tags', 'POST', { name: draft.name }),
    );
  const keep = new Set(resolved.map((tag) => tag.id));
  for (const tag of previous)
    if (!keep.has(tag.id)) await send(`/tasks/${taskId}/tags/${tag.id}`, 'DELETE');
  const had = new Set(previous.map((tag) => tag.id));
  for (const tag of resolved)
    if (!had.has(tag.id)) await send(`/tasks/${taskId}/tags`, 'POST', { tagId: tag.id });
}
function TagChip({ tag }: { tag: TagDraft }) {
  const accent = tagAccent(tag);
  return (
    <span className="tag-chip" style={{ borderColor: accent }}>
      <span className="tag-dot" style={{ background: accent }} />
      {tag.name}
    </span>
  );
}
/**
 * Controlled multi-value tag field. The rest of the forms read their values from `FormData`
 * on submit, which cannot express a list of tags resolved against a shared table, so this one
 * is controlled and reports every change to its owner.
 *
 * Enter or a comma commits the typed name; Backspace on an empty field removes the last chip;
 * blur commits too, so a name typed and then submitted is never quietly dropped. Names are
 * normalized and matched against `available` case-insensitively before a new tag is proposed.
 */
function TagChipInput({
  label,
  chosen,
  available,
  onChange,
}: {
  label: string;
  chosen: TagDraft[];
  available: Tag[];
  onChange: (next: TagDraft[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const commit = (raw: string) => {
    const name = normalizeTagName(raw);
    setDraft('');
    if (!name || chosen.some((tag) => sameTagName(tag.name, name))) return;
    onChange([...chosen, available.find((tag) => sameTagName(tag.name, name)) ?? { name }]);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter would otherwise submit the surrounding task form with the name still unread.
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && !draft && chosen.length) onChange(chosen.slice(0, -1));
  };
  return (
    <div className="chip-input">
      <span className="chip-input-label">{label}</span>
      {chosen.length > 0 && (
        <ul className="tag-list" aria-label={`Selected ${label.toLowerCase()}`}>
          {chosen.map((tag) => (
            <li key={tag.id ?? `new-${tag.name}`}>
              <TagChip tag={tag} />
              <button
                type="button"
                className="tag-remove"
                onClick={() => onChange(chosen.filter((candidate) => candidate !== tag))}
                aria-label={`Remove tag ${tag.name}`}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="chip-input-row">
        <input
          value={draft}
          list={listId}
          aria-label="Add a tag"
          placeholder="Type a tag, then press Enter"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={keyDown}
          onBlur={() => commit(draft)}
        />
        <button type="button" onClick={() => commit(draft)}>
          <Plus /> Add
        </button>
      </div>
      <datalist id={listId}>
        {available
          .filter((tag) => !chosen.some((candidate) => sameTagName(candidate.name, tag.name)))
          .map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
      </datalist>
    </div>
  );
}
function FormEnd({ error, busy, label }: { error: string; busy: boolean; label: string }) {
  return (
    <>
      <div className="form-error" role="alert">
        {error}
      </div>
      <button className="submit" disabled={busy}>
        {busy ? (
          <>
            <RefreshCw className="spin" /> Saving…
          </>
        ) : (
          label
        )}
      </button>
    </>
  );
}
function SearchBox({
  value,
  set,
  placeholder,
}: {
  value: string;
  set: (s: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Search />
      <span className="sr-only">Search</span>
      <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} />
      {value && (
        <button onClick={() => set('')} aria-label="Clear search">
          <X />
        </button>
      )}
    </label>
  );
}
function DriveBadge({ status }: { status: DriveStatus | string | undefined }) {
  const value = (status || 'DISCONNECTED').toLowerCase();
  return (
    <span className={`drive-badge ${value}`}>
      <span />
      {value === 'connected'
        ? 'Drive ready'
        : value === 'pending'
          ? 'Drive pending'
          : value === 'failed'
            ? 'Drive issue'
            : 'Drive offline'}
    </span>
  );
}
function TaskTypeBadge({ type }: { type: TaskType }) {
  return <span className="task-type-badge">{TASK_TYPE_LABEL[type]}</span>;
}
function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`priority-badge ${priority.toLowerCase()}`}>{priority}</span>;
}
function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`status-dot ${status.toLowerCase()}`} title={STATUS_LABEL[status]} />;
}
function Due({ task }: { task: Task }) {
  if (!task.dueDate)
    return (
      <span className="due muted">
        <CalendarDays /> No date
      </span>
    );
  return (
    <span className={`due ${task.overdue ? 'overdue-text' : ''}`}>
      <CalendarDays />
      {task.overdue ? 'Due ' : ''}
      {formatDate(task.dueDate)}
    </span>
  );
}
function Empty({
  title,
  body,
  action,
  compact,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? 'compact' : ''}`}>
      <div>
        <FolderKanban />
      </div>
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}
const formatDate = (value: string) => {
  try {
    return format(parseISO(value), 'MMM d, yyyy');
  } catch {
    return value;
  }
};
const formatDataAge = (elapsedMs: number) => {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
};
const dateInput = (value?: string) => value?.slice(0, 10) || '';
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((x) => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

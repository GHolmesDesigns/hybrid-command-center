import { useCallback, useEffect, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  Bot,
  Bell,
  HeartPulse,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  FileText,
  FolderKanban,
  LayoutDashboard,
  Megaphone,
  Menu,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plus,
  Settings,
  Timer,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { Category, Client, DashboardData, Project, Tag, Task } from '../../../shared/types';
import { APP_VERSION, DEFAULT_BRANDING, type Branding } from '../../../shared/branding';
import { CANONICAL_VIEW_DEFAULTS, type ViewDefaults } from '../../../shared/view-defaults';
import { readTaskTimer } from '../../../shared/task-timer';
import { resolveGlobalStartTask, startTaskPath } from '../../../shared/start-task';
import {
  DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS,
  type AgentHubLiveTipsSettings,
} from '../../../shared/agent-hub-sse';
import { useAgentHubTips, useDebouncedAgentHubTip } from '../useAgentHubTips';
import { AgentHubTipsContext } from './AgentHubTipsContext';
import { BreadcrumbTrail } from './BreadcrumbTrail';
import { ClientDetail, Clients } from './Clients';
import { Dashboard } from './Dashboard';
import { FilesView } from './FilesView';
import { CalendarView } from './CalendarView';
import { ImportView } from './ImportView';
import { Kanban } from './Kanban';
import { ModalHost } from './Modals';
import { BrandMark } from './Primitives';
import { ProjectDetail } from './ProjectDetail';
import { Projects } from './Projects';
import { AgentsView } from './AgentsView';
import { SettingsView } from './SettingsView';
import { SignalView } from './SignalView';
import { TasksView } from './TasksView';
import { HealthView } from './HealthView';
import { ConversationsView } from './ConversationsView';
import { CommandAiFab, CommandAiPanel, CommandAiTopbarToggle } from './CommandAiPanel';
import { TaskDetail } from './TaskDetail';
import { PageHead } from './Shell';
import { Nav } from './Shell';
import { brandStyle } from './ui-shared';

export type Modal =
  | { type: 'client'; value?: Client }
  | { type: 'clientMerge'; source: Client }
  | { type: 'project'; value?: Project; clientId?: string }
  | { type: 'task'; value?: Task; projectId?: string }
  | { type: 'taskDetail'; value: Task }
  | { type: 'import' }
  | { type: 'signalImport' }
  | null;

const SIDEBAR_KEY = 'hcc-sidebar-collapsed';
const COMMAND_AI_KEY = 'hcc-command-ai-open';

const LAST_PROJECT_KEY = 'hcc-last-project';

/** Old Status URL. Preserves filters so `/kanban?filter=today` still opens today's board. */
function LegacyKanbanRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/status${search}`} replace />;
}

/**
 * Opens Signal's shared Add Post form (`new=1`).
 *
 * On Signal it merges into the current address so month/view/campaign filters stay put; elsewhere
 * it navigates to Signal with an unscheduled draft. The form itself lives in SignalView — this is
 * only the top-bar entry point.
 */
function TopbarAddPost() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const open = () => {
    if (location.pathname === '/signal') {
      const next = new URLSearchParams(params);
      next.delete('post');
      next.set('new', '1');
      navigate({ pathname: '/signal', search: next.toString() }, { replace: true });
      return;
    }
    navigate('/signal?new=1');
  };
  return (
    <button className="top-action" type="button" onClick={open}>
      <Plus /> Add post
    </button>
  );
}

function TopbarStartTask({
  modal,
  tasks,
  projects,
  clients,
}: {
  modal: Modal;
  tasks: Task[];
  projects: Project[];
  clients: Client[];
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [savedSessionTaskId, setSavedSessionTaskId] = useState<string | null>(
    () => readTaskTimer(window.localStorage)?.taskId ?? null,
  );
  useEffect(() => {
    const refresh = () => setSavedSessionTaskId(readTaskTimer(window.localStorage)?.taskId ?? null);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const routeTaskId =
    location.pathname.startsWith('/tasks/') && location.pathname !== '/tasks'
      ? location.pathname.slice('/tasks/'.length).split('/')[0] || null
      : null;
  const modalTask = modal?.type === 'taskDetail' ? modal.value : null;
  const { taskId, disabledReason } = resolveGlobalStartTask({
    modalTask,
    routeTaskId,
    savedSessionTaskId,
    tasks,
    projects,
    clients,
  });
  const disabled = !taskId;
  const title = disabledReason ?? (disabled ? 'No task is available to start' : 'Start Task');
  return (
    <button
      className="top-action"
      type="button"
      disabled={disabled}
      title={title}
      aria-label={disabled ? title : 'Start Task'}
      onClick={() => {
        if (!taskId) return;
        navigate(startTaskPath(taskId));
      }}
    >
      <Play /> Start Task
    </button>
  );
}

function TaskDetailRoute({
  tasks,
  projects,
  clients,
  tags,
  refresh,
  flash,
  edit,
}: {
  tasks: Task[];
  projects: Project[];
  clients: Client[];
  tags: Tag[];
  refresh: () => Promise<void>;
  flash: (text: string, tone?: 'success' | 'error') => void;
  edit: (task: Task) => void;
}) {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task)
    return (
      <>
        <div className="backline">
          <button className="link-button" onClick={() => navigate('/tasks')}>
            ← All tasks
          </button>
        </div>
        <PageHead
          focusOnMount
          eyebrow="Task"
          title="Task not found"
          body="This task may have been deleted or is no longer available in Command Center."
        />
      </>
    );
  const activeProjectIds = new Set(
    projects
      .filter(
        (project) =>
          project.status !== 'ARCHIVED' &&
          !clients.some((client) => client.id === project.clientId && client.status === 'ARCHIVED'),
      )
      .map((project) => project.id),
  );
  const visibleTasks = tasks.filter(
    (candidate) =>
      activeProjectIds.has(candidate.projectId) ||
      candidate.id === task.id ||
      task.dependencyIds.includes(candidate.id),
  );
  return (
    <>
      <div className="backline">
        <button className="link-button" onClick={() => navigate('/tasks')}>
          ← All tasks
        </button>
      </div>
      <TaskDetail
        task={task}
        tasks={visibleTasks}
        tags={tags}
        close={() => navigate('/tasks')}
        edit={() => edit(task)}
        refresh={refresh}
        flash={flash}
        projectExists={projects.some((project) => project.id === task.projectId)}
        clientExists={clients.some((client) => client.id === task.clientId)}
      />
    </>
  );
}

export function App() {
  const [clients, setClients] = useState<Client[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [tags, setTags] = useState<Tag[]>([]),
    [categories, setCategories] = useState<Category[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null),
    [loading, setLoading] = useState(true),
    [modal, setModal] = useState<Modal>(null);
  const [dashboardRefreshedAt, setDashboardRefreshedAt] = useState<number | null>(null),
    [dashboardRefreshError, setDashboardRefreshError] = useState<string | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null),
    [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  const [commandAiOpen, setCommandAiOpen] = useState(
    () => localStorage.getItem(COMMAND_AI_KEY) === '1',
  );
  const [lastProjectId, setLastProjectId] = useState(
    () => localStorage.getItem(LAST_PROJECT_KEY) || '',
  );
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [viewDefaults, setViewDefaults] = useState<ViewDefaults>(CANONICAL_VIEW_DEFAULTS);
  const [liveTips, setLiveTips] = useState<AgentHubLiveTipsSettings>(
    DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS,
  );
  // When the last import wrote its receipt. The Import page reloads its receipts on it, so a
  // modal that finished in front of the page does not leave a stale list behind it.
  const [importedAt, setImportedAt] = useState(0);
  const location = useLocation();
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [c, p, t, d, b, g, k, v, tips] = await Promise.all([
        api<Client[]>('/clients'),
        api<Project[]>('/projects'),
        api<Task[]>('/tasks'),
        api<DashboardData>('/dashboard'),
        api<{ branding: Branding }>('/settings/branding'),
        api<Tag[]>('/tags'),
        api<Category[]>('/categories'),
        api<{ viewDefaults: ViewDefaults }>('/settings/view-defaults'),
        api<{ liveTips: AgentHubLiveTipsSettings }>('/settings/agent-hub-live-tips'),
      ]);
      setClients(c);
      setProjects(p);
      setTasks(t);
      setDashboard(d);
      setDashboardRefreshedAt(Date.now());
      setDashboardRefreshError(null);
      setBranding(b.branding);
      setTags(g);
      setCategories(k);
      setViewDefaults(v.viewDefaults);
      setLiveTips(tips.liveTips);
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
  const refreshUnreadNotifications = useCallback(() => {
    api<{ unreadCount?: number }>('/agent-notifications?unreadOnly=true&limit=1')
      .then((result) => setUnreadNotifications(result.unreadCount ?? 0))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshUnreadNotifications();
  }, [location.pathname, refreshUnreadNotifications]);
  const { subscribe: subscribeAgentHubTips } = useAgentHubTips(liveTips.enabled);
  useDebouncedAgentHubTip(
    liveTips.enabled ? subscribeAgentHubTips : null,
    'notifications',
    refreshUnreadNotifications,
  );
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem(COMMAND_AI_KEY, commandAiOpen ? '1' : '0');
  }, [commandAiOpen]);
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
  const open = (next: Modal) => setModal(next);
  const toggleCollapse = () => setCollapsed((v) => !v);
  // The remembered project is only a default, and only while TaskForm() still offers it.
  const defaultProject = projects.some((p) => p.id === lastProjectId && p.status !== 'ARCHIVED')
    ? lastProjectId
    : undefined;
  if (loading)
    return (
      <div className="splash" style={brandStyle(branding)}>
        <BrandMark branding={branding} />
        <p>Organizing your command center…</p>
      </div>
    );
  return (
    <AgentHubTipsContext.Provider value={liveTips.enabled ? subscribeAgentHubTips : null}>
      <div
        className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${commandAiOpen ? 'command-ai-open' : ''}`}
      >
        <aside
          className={`sidebar ${navOpen ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}
          style={brandStyle(branding)}
        >
          <div className="brand">
            <BrandMark branding={branding} />
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
            <Nav
              icon={<BriefcaseBusiness />}
              to="/projects"
              label="Projects"
              collapsed={collapsed}
            />
            <Nav icon={<FolderKanban />} to="/status" label="Status" collapsed={collapsed} />
            <Nav icon={<Timer />} to="/tasks" label="Tasks" collapsed={collapsed} />
            <Nav icon={<Upload />} to="/import" label="Import" collapsed={collapsed} />
            <Nav icon={<FileText />} to="/files" label="Files" collapsed={collapsed} />
            <Nav icon={<CalendarDays />} to="/calendar" label="Calendar" collapsed={collapsed} />
            <Nav icon={<Megaphone />} to="/signal" label="Signal" collapsed={collapsed} />
            <Nav icon={<HeartPulse />} to="/health" label="Health" collapsed={collapsed} />
            <Nav
              icon={
                <>
                  <Bot />
                  <Bell
                    aria-label={
                      unreadNotifications
                        ? `${unreadNotifications} unread notifications`
                        : 'Notifications'
                    }
                  />
                </>
              }
              to="/agents"
              label="Agents"
              collapsed={collapsed}
            />
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
            <BreadcrumbTrail clients={clients} projects={projects} tasks={tasks} />
            <div className="top-actions">
              <TopbarStartTask modal={modal} tasks={tasks} projects={projects} clients={clients} />
              <button
                className="top-action"
                onClick={() => setModal({ type: 'task', projectId: defaultProject })}
              >
                <Plus /> New task
              </button>
              <TopbarAddPost />
              <CommandAiTopbarToggle
                open={commandAiOpen}
                onClick={() => setCommandAiOpen((value) => !value)}
              />
            </div>
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
                    open={open}
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
                    viewDefaults={viewDefaults}
                    open={open}
                    refresh={refresh}
                    flash={flash}
                  />
                }
              />
              <Route
                path="/clients/:id"
                element={
                  <ClientDetail
                    clients={clients}
                    projects={projects}
                    open={open}
                    refresh={refresh}
                    flash={flash}
                  />
                }
              />
              <Route
                path="/projects"
                element={
                  <Projects
                    projects={projects}
                    updateProjects={setProjects}
                    clients={clients}
                    categories={categories}
                    tasks={tasks}
                    viewDefaults={viewDefaults}
                    open={open}
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
                    updateTasks={setTasks}
                    open={open}
                    remember={setLastProjectId}
                    refresh={refresh}
                    flash={flash}
                  />
                }
              />
              <Route
                path="/status"
                element={
                  <Kanban
                    tasks={tasks}
                    updateTasks={setTasks}
                    clients={clients}
                    projects={projects}
                    tags={tags}
                    open={open}
                    remember={setLastProjectId}
                    refresh={refresh}
                    flash={flash}
                  />
                }
              />
              {/* Bookmarks and older dashboard tiles still use /kanban; keep the query string. */}
              <Route path="/kanban" element={<LegacyKanbanRedirect />} />
              <Route
                path="/tasks"
                element={
                  <TasksView tasks={tasks} clients={clients} projects={projects} tags={tags} />
                }
              />
              <Route
                path="/tasks/:taskId"
                element={
                  <TaskDetailRoute
                    tasks={tasks}
                    projects={projects}
                    clients={clients}
                    tags={tags}
                    refresh={refresh}
                    flash={flash}
                    edit={(task) => setModal({ type: 'task', value: task })}
                  />
                }
              />
              <Route
                path="/import"
                element={
                  <ImportView
                    open={() => setModal({ type: 'import' })}
                    openSignal={() => setModal({ type: 'signalImport' })}
                    importedAt={importedAt}
                  />
                }
              />
              <Route
                path="/files"
                element={
                  <FilesView
                    projects={projects}
                    defaultProject={defaultProject}
                    remember={setLastProjectId}
                  />
                }
              />
              <Route path="/calendar" element={<CalendarView viewDefaults={viewDefaults} />} />
              <Route path="/signal" element={<SignalView viewDefaults={viewDefaults} />} />
              <Route path="/agents" element={<AgentsView tasks={tasks} flash={flash} />} />
              <Route
                path="/agents/conversations"
                element={<ConversationsView flash={flash} liveTipsEnabled={liveTips.enabled} />}
              />
              <Route path="/health" element={<HealthView />} />
              <Route
                path="/settings"
                element={
                  <SettingsView
                    branding={branding}
                    viewDefaults={viewDefaults}
                    liveTips={liveTips}
                    onLiveTipsSaved={setLiveTips}
                    tags={tags}
                    tasks={tasks}
                    categories={categories}
                    projects={projects}
                    clients={clients}
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
            categories={categories}
            close={() => setModal(null)}
            edit={(task) => setModal({ type: 'task', value: task })}
            saved={saved}
            imported={() => setImportedAt(Date.now())}
            refresh={refresh}
            flash={flash}
          />
        )}
        <CommandAiPanel open={commandAiOpen} onClose={() => setCommandAiOpen(false)} />
        <CommandAiFab open={commandAiOpen} onClick={() => setCommandAiOpen(true)} />
        {notice && (
          <div className={`toast ${notice.tone}`} role="status">
            {notice.tone === 'success' ? <CheckCircle2 /> : <CircleAlert />}
            {notice.text}
          </div>
        )}
      </div>
    </AgentHubTipsContext.Provider>
  );
}

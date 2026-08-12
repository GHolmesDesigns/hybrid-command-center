import { useCallback, useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import {
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderKanban,
  LayoutDashboard,
  Menu,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { Client, DashboardData, Project, Tag, Task } from '../../../shared/types';
import { APP_VERSION, DEFAULT_BRANDING, type Branding } from '../../../shared/branding';
import { ClientDetail, Clients } from './Clients';
import { Dashboard } from './Dashboard';
import { pageName } from './formatting';
import { Kanban } from './Kanban';
import { ModalHost } from './Modals';
import { ProjectDetail } from './ProjectDetail';
import { Projects } from './Projects';
import { SettingsView } from './SettingsView';
import { Nav } from './Shell';

export type Modal =
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

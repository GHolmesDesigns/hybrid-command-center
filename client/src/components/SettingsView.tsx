import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  FolderKanban,
  LayoutDashboard,
  Pencil,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { api, send } from '../api';
import { useServerSeeded } from '../useServerSeeded';
import { DrivePickerCancelled, pickDriveFolder, type DrivePickerConfig } from '../drivePicker';
import type { Category, Client, Project, Tag, Task } from '../../../shared/types';
import {
  APP_VERSION,
  BRANDING_COLOR_FIELDS,
  DEFAULT_BRANDING,
  LOGO_URL_MAX,
  brandingContrastReadings,
  brandingIssues,
  type Branding,
  type BrandingColorField,
} from '../../../shared/branding';
import { CALENDAR_VIEWS } from '../../../shared/calendar';
import { normalizeHex } from '../../../shared/contrast';
import {
  CANONICAL_VIEW_DEFAULTS,
  CLIENT_VISIBILITIES,
  CLIENT_VISIBILITY_LABEL,
  PROJECT_SORTS,
  PROJECT_SORT_LABEL,
  PROJECT_PRESENTATION_LABEL,
  PROJECT_VISIBILITIES,
  PROJECT_VISIBILITY_LABEL,
  TIME_VIEW_LABEL,
  viewDefaultsIssues,
  type ViewDefaults,
} from '../../../shared/view-defaults';
import { PROJECT_PRESENTATIONS } from '../../../shared/project-view';
import { BrandMark, DriveBadge } from './Primitives';
import { PageHead } from './Shell';
import { brandStyle } from './ui-shared';
import { CategoriesCard } from './CategoriesCard';
import { SignalCampaignsCard } from './SignalCampaignsCard';
import { TagsCard } from './TagsCard';
import { manualUrlForVersion } from '../../../shared/manual';
import {
  readTaskTimerSettings,
  writeTaskTimerSettings,
  type TaskTimerSettings,
} from '../../../shared/task-timer';
import type { AgentHubLiveTipsSettings } from '../../../shared/agent-hub-sse';

const COLOR_LABEL: Record<BrandingColorField, string> = {
  background: 'Sidebar background',
  foreground: 'Sidebar text',
  accent: 'Accent',
};

type DriveSettingsState = {
  configured: boolean;
  pickerConfigured: boolean;
  connected: boolean;
  rootFolderId?: string;
  rootFolderUrl?: string;
  picker: DrivePickerConfig | null;
};

type ManualState = {
  version: string;
  available: boolean;
  url: string | null;
};

type NotificationPermissionState = NotificationPermission | 'unavailable';

function readNotificationPermission(): NotificationPermissionState {
  return typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;
}

export function SettingsView({
  branding,
  viewDefaults,
  liveTips,
  onLiveTipsSaved,
  tags,
  tasks,
  categories,
  projects,
  clients,
  refresh,
  flash,
}: {
  branding: Branding;
  viewDefaults: ViewDefaults;
  liveTips: AgentHubLiveTipsSettings;
  onLiveTipsSaved: (value: AgentHubLiveTipsSettings) => void;
  tags: Tag[];
  tasks: Task[];
  categories: Category[];
  projects: Project[];
  clients: Client[];
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [state, setState] = useState<DriveSettingsState | null>(null),
    [manual, setManual] = useState<ManualState | null>(null),
    [manualError, setManualError] = useState(''),
    [brandForm, setBrandForm, brandSaved] = useServerSeeded<Branding>(branding),
    [viewsForm, setViewsForm, viewsSaved] = useServerSeeded<ViewDefaults>(viewDefaults),
    [brandBusy, setBrandBusy] = useState(false),
    [viewsBusy, setViewsBusy] = useState(false),
    [pickerBusy, setPickerBusy] = useState(false),
    [driveError, setDriveError] = useState('');
  const [timerSettings, setTimerSettings] = useState<TaskTimerSettings>(() =>
    readTaskTimerSettings(window.localStorage),
  );
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(
    readNotificationPermission,
  );
  const [liveTipsForm, setLiveTipsForm, markLiveTipsSaved] =
    useServerSeeded<AgentHubLiveTipsSettings>(liveTips);
  const [liveTipsBusy, setLiveTipsBusy] = useState(false);
  const load = useCallback(async () => {
    const next = await api<DriveSettingsState>('/settings/drive');
    setState(next);
    setDriveError('');
  }, []);
  useEffect(() => {
    void load().catch((error: unknown) => setDriveError((error as Error).message));
  }, [load]);
  useEffect(() => {
    void api<ManualState>('/settings/manual')
      .then((next) => setManual(next))
      .catch((error: unknown) => setManualError((error as Error).message));
  }, []);
  useEffect(() => {
    const refreshPermission = () => setNotificationPermission(readNotificationPermission());
    document.addEventListener('visibilitychange', refreshPermission);
    return () => document.removeEventListener('visibilitychange', refreshPermission);
  }, []);
  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') return;
    setNotificationPermission(await Notification.requestPermission());
  };
  const connect = async () => {
    try {
      const { url } = await api<{ url: string }>('/drive/oauth/start');
      window.location.href = url;
    } catch (e) {
      flash((e as Error).message, 'error');
    }
  };
  const chooseRoot = async () => {
    if (!state?.picker) {
      flash('Add GOOGLE_API_KEY and GOOGLE_APP_ID to .env, then restart.', 'error');
      return;
    }
    setPickerBusy(true);
    try {
      const folder = await pickDriveFolder(state.picker);
      await send('/settings/drive/root', 'POST', { folderId: folder.id });
      await load();
      await refresh();
      flash('Command Center root folder saved.');
    } catch (err) {
      if (err instanceof DrivePickerCancelled) return;
      flash((err as Error).message, 'error');
    } finally {
      setPickerBusy(false);
    }
  };
  const disconnect = async () => {
    if (
      !confirm(
        'Disconnect Google Drive? Local project data will remain, and no Drive files will be deleted.\n\nThis only removes credentials stored here. Revoke the app separately in Google Account → Third-party access if you are cutting over from the old full-Drive grant or after a suspected exposure.',
      )
    )
      return;
    const result = await send<{
      ok: true;
      googleRevocationRequired?: boolean;
      googlePermissionsUrl?: string;
    }>('/settings/drive/disconnect', 'POST');
    await load();
    if (result.googleRevocationRequired && result.googlePermissionsUrl) {
      flash(
        `Google Drive disconnected locally. To revoke the Google grant (required after a full-Drive cutover), open ${result.googlePermissionsUrl}`,
      );
    } else {
      flash('Google Drive disconnected.');
    }
  };
  const brandProblems = brandingIssues(brandForm),
    contrast = brandingContrastReadings(brandForm),
    logoProblems = brandProblems.filter(
      (issue) => issue.field === 'logoUrl' || issue.field === 'logoAlt',
    );
  const saveBranding = async (e: FormEvent) => {
    e.preventDefault();
    // The server refuses these too. Stopping here is what makes the reason readable rather
    // than a single validation message returned for whichever field failed first.
    if (brandProblems.length) return flash(brandProblems[0].message, 'error');
    setBrandBusy(true);
    try {
      await send('/settings/branding', 'PUT', brandForm);
      // The write is what the form now agrees with, so the next branding the app hands down may
      // seed it again. Without this the panel would stay detached after its first edit.
      brandSaved();
      await refresh();
      flash('Sidebar branding saved.');
    } catch (err) {
      flash((err as Error).message, 'error');
    } finally {
      setBrandBusy(false);
    }
  };
  const viewsProblems = viewDefaultsIssues(viewsForm);
  const saveViewDefaults = async (e: FormEvent) => {
    e.preventDefault();
    if (viewsProblems.length) return flash(viewsProblems[0].message, 'error');
    setViewsBusy(true);
    try {
      await send('/settings/view-defaults', 'PUT', viewsForm);
      viewsSaved();
      await refresh();
      flash('Default views saved.');
    } catch (err) {
      flash((err as Error).message, 'error');
    } finally {
      setViewsBusy(false);
    }
  };
  const effectiveViews = [
    `${CLIENT_VISIBILITY_LABEL[viewsForm.clients.visibility]} clients`,
    `${PROJECT_VISIBILITY_LABEL[viewsForm.projects.visibility]} projects in ${PROJECT_PRESENTATION_LABEL[viewsForm.projects.presentation]} view by ${PROJECT_SORT_LABEL[viewsForm.projects.sort]}`,
    `Calendar ${TIME_VIEW_LABEL[viewsForm.calendar.view]}`,
    `Signal ${TIME_VIEW_LABEL[viewsForm.signal.view]}`,
  ].join(' · ');
  return (
    <>
      <PageHead
        eyebrow="Workspace"
        title="Settings"
        body="Connect storage, shape the sidebar brand, and control how this local command center behaves."
      />
      {/*
        Two independent stacks rather than six cards sharing a two-column grid's rows. Cards
        that share a row share a starting edge, so the taller of a pair decided where the next
        card on the *other* side began: a Drive card that grew on connecting, a validation
        message that appeared, or a category list that wrapped left a blank strip beside it.
        A column is its own flow, so only the cards above a card in the same stack move it.

        The stacks are the reading order too. Below 1100px they sit one under the other, and
        because nothing is reordered in CSS, what the keyboard and a screen reader follow is
        what is on screen at both widths: labels the workspace organises by, then defaults,
        appearance, integrations, and the remaining modules.
      */}
      <div className="settings-layout">
        <div className="settings-column">
          <section className="panel settings-card" aria-labelledby="agent-hub-live-tips-heading">
            <div className="section-title">
              <div>
                <span className="eyebrow">Agents</span>
                <h2 id="agent-hub-live-tips-heading">Live updates</h2>
              </div>
            </div>
            <p>
              Keep conversation messages and notifications current while you work. Wake frames name
              which feeds changed — never message bodies or counts. If the live channel disconnects,
              navigation and manual refresh still work.
            </p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setLiveTipsBusy(true);
                try {
                  const saved = await send<{ liveTips: AgentHubLiveTipsSettings }>(
                    '/settings/agent-hub-live-tips',
                    'PUT',
                    liveTipsForm,
                  );
                  onLiveTipsSaved(saved.liveTips);
                  setLiveTipsForm(saved.liveTips);
                  markLiveTipsSaved();
                  flash('Live updates saved.');
                } catch (error) {
                  flash((error as Error).message, 'error');
                } finally {
                  setLiveTipsBusy(false);
                }
              }}
            >
              <label>
                <input
                  type="checkbox"
                  checked={liveTipsForm.enabled}
                  onChange={(event) =>
                    setLiveTipsForm({ ...liveTipsForm, enabled: event.target.checked })
                  }
                />{' '}
                Enable live updates
              </label>
              <div className="brand-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setLiveTipsForm({ enabled: false })}
                  disabled={liveTipsBusy}
                >
                  <RotateCcw /> Turn off
                </button>
                <button className="submit" disabled={liveTipsBusy}>
                  {liveTipsBusy ? (
                    <>
                      <RefreshCw className="spin" /> Saving…
                    </>
                  ) : (
                    'Save live updates'
                  )}
                </button>
              </div>
            </form>
          </section>
          <section className="panel settings-card" aria-labelledby="timer-settings-heading">
            <div className="section-title">
              <div>
                <span className="eyebrow">Tasks</span>
                <h2 id="timer-settings-heading">Timer notifications</h2>
              </div>
            </div>
            <p>
              Completion alerts work while the page is hidden. Browser-closed push notifications are
              not supported.
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => void requestNotificationPermission()}
              disabled={notificationPermission === 'unavailable'}
            >
              Allow notifications
            </button>
            <p className="field-hint" role="status" aria-label="Notification permission status">
              Permission:{' '}
              {notificationPermission === 'unavailable' ? 'Unavailable' : notificationPermission}.
            </p>
            <div className="timer-notification-options">
              <label>
                <input
                  type="checkbox"
                  checked={timerSettings.enabled}
                  onChange={(e) => {
                    const next = { ...timerSettings, enabled: e.target.checked };
                    setTimerSettings(next);
                    writeTaskTimerSettings(window.localStorage, next);
                  }}
                />{' '}
                Enable timer notifications
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={timerSettings.completion}
                  disabled={!timerSettings.enabled}
                  onChange={(e) => {
                    const next = { ...timerSettings, completion: e.target.checked };
                    setTimerSettings(next);
                    writeTaskTimerSettings(window.localStorage, next);
                  }}
                />{' '}
                Session completion
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={timerSettings.unavailable}
                  disabled={!timerSettings.enabled}
                  onChange={(e) => {
                    const next = { ...timerSettings, unavailable: e.target.checked };
                    setTimerSettings(next);
                    writeTaskTimerSettings(window.localStorage, next);
                  }}
                />{' '}
                Permission unavailable warnings
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={timerSettings.sound}
                  disabled={!timerSettings.enabled}
                  onChange={(e) => {
                    const next = { ...timerSettings, sound: e.target.checked };
                    setTimerSettings(next);
                    writeTaskTimerSettings(window.localStorage, next);
                  }}
                />{' '}
                Sound when supported
              </label>
            </div>
          </section>
          <CategoriesCard
            categories={categories}
            projects={projects}
            refresh={refresh}
            flash={flash}
          />
          <TagsCard tags={tags} tasks={tasks} refresh={refresh} flash={flash} />
          {/* Campaigns label Signal posts just as categories label projects and tags label tasks. */}
          <SignalCampaignsCard flash={flash} />
        </div>
        <div className="settings-column">
          <section className="panel settings-card">
            <div className="settings-icon neutral">
              <FileText />
            </div>
            <div className="section-title">
              <div>
                <span className="eyebrow">Help</span>
                <h2>User manual</h2>
              </div>
              {manual?.version && <span className="version-pill">v{manual.version}</span>}
            </div>
            <p>Open the operating manual for the version running on this device.</p>
            {manualError || (manual && !manual.available) ? (
              <p className="field-hint" role="status">
                The user manual for this version is not available yet.
              </p>
            ) : manual ? (
              <a
                className="buttonlike secondary settings-link"
                href={manual.url ?? manualUrlForVersion(manual.version)}
                target="_blank"
                rel="noreferrer"
              >
                <FileText /> Open user manual <ExternalLink aria-hidden="true" />
              </a>
            ) : (
              <p className="field-hint" role="status">
                Checking for the matching manual…
              </p>
            )}
          </section>
          <section className="panel settings-card">
            <div className="settings-icon neutral">
              <LayoutDashboard />
            </div>
            <div className="section-title">
              <div>
                <span className="eyebrow">Layout</span>
                <h2>Default views</h2>
              </div>
            </div>
            <p>
              Choose how Clients, Projects, Calendar, and Signal open when the address omits that
              choice. A shared or bookmarked URL still wins; Reset restores the shipped defaults.
            </p>
            <form className="form brand-form" onSubmit={saveViewDefaults}>
              <label>
                Clients visibility
                <select
                  aria-label="Clients visibility default"
                  value={viewsForm.clients.visibility}
                  onChange={(e) =>
                    setViewsForm({
                      ...viewsForm,
                      clients: {
                        visibility: e.target.value as (typeof CLIENT_VISIBILITIES)[number],
                      },
                    })
                  }
                >
                  {CLIENT_VISIBILITIES.map((value) => (
                    <option key={value} value={value}>
                      {CLIENT_VISIBILITY_LABEL[value]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-row">
                <label>
                  Projects visibility
                  <select
                    aria-label="Projects visibility default"
                    value={viewsForm.projects.visibility}
                    onChange={(e) =>
                      setViewsForm({
                        ...viewsForm,
                        projects: {
                          ...viewsForm.projects,
                          visibility: e.target.value as (typeof PROJECT_VISIBILITIES)[number],
                        },
                      })
                    }
                  >
                    {PROJECT_VISIBILITIES.map((value) => (
                      <option key={value} value={value}>
                        {PROJECT_VISIBILITY_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Projects sort
                  <select
                    aria-label="Projects sort default"
                    value={viewsForm.projects.sort}
                    onChange={(e) =>
                      setViewsForm({
                        ...viewsForm,
                        projects: {
                          ...viewsForm.projects,
                          sort: e.target.value as (typeof PROJECT_SORTS)[number],
                        },
                      })
                    }
                  >
                    {PROJECT_SORTS.map((value) => (
                      <option key={value} value={value}>
                        {PROJECT_SORT_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Projects presentation
                <select
                  aria-label="Projects presentation default"
                  value={viewsForm.projects.presentation}
                  onChange={(e) =>
                    setViewsForm({
                      ...viewsForm,
                      projects: {
                        ...viewsForm.projects,
                        presentation: e.target.value as (typeof PROJECT_PRESENTATIONS)[number],
                      },
                    })
                  }
                >
                  {PROJECT_PRESENTATIONS.map((value) => (
                    <option key={value} value={value}>
                      {PROJECT_PRESENTATION_LABEL[value]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-row">
                <label>
                  Calendar view
                  <select
                    aria-label="Calendar view default"
                    value={viewsForm.calendar.view}
                    onChange={(e) =>
                      setViewsForm({
                        ...viewsForm,
                        calendar: {
                          view: e.target.value as (typeof CALENDAR_VIEWS)[number],
                        },
                      })
                    }
                  >
                    {CALENDAR_VIEWS.map((value) => (
                      <option key={value} value={value}>
                        {TIME_VIEW_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Signal view
                  <select
                    aria-label="Signal view default"
                    value={viewsForm.signal.view}
                    onChange={(e) =>
                      setViewsForm({
                        ...viewsForm,
                        signal: {
                          view: e.target.value as (typeof CALENDAR_VIEWS)[number],
                        },
                      })
                    }
                  >
                    {CALENDAR_VIEWS.map((value) => (
                      <option key={value} value={value}>
                        {TIME_VIEW_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Signal default client
                  <select
                    aria-label="Signal default client"
                    value={viewsForm.signal.clientId}
                    onChange={(e) =>
                      setViewsForm({
                        ...viewsForm,
                        signal: { ...viewsForm.signal, clientId: e.target.value },
                      })
                    }
                  >
                    <option value="">G.Holmes Designs (saved fallback)</option>
                    {clients
                      .filter((client) => client.status === 'ACTIVE')
                      .map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Signal clients
                  <select
                    aria-label="Signal client visibility default"
                    value={viewsForm.signal.clientVisibility}
                    onChange={(e) =>
                      setViewsForm({
                        ...viewsForm,
                        signal: {
                          ...viewsForm.signal,
                          clientVisibility: e.target.value as 'active' | 'all',
                        },
                      })
                    }
                  >
                    <option value="active">Active only</option>
                    <option value="all">Show inactive</option>
                  </select>
                </label>
                <label>
                  Signal projects
                  <select
                    aria-label="Signal project visibility default"
                    value={viewsForm.signal.projectVisibility}
                    onChange={(e) =>
                      setViewsForm({
                        ...viewsForm,
                        signal: {
                          ...viewsForm.signal,
                          projectVisibility: e.target.value as 'active' | 'all',
                        },
                      })
                    }
                  >
                    <option value="active">Active only</option>
                    <option value="all">Show inactive</option>
                  </select>
                </label>
              </div>
              <p className="field-hint" role="status">
                Effective: {effectiveViews}
              </p>
              <div className="brand-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setViewsForm({ ...CANONICAL_VIEW_DEFAULTS })}
                  disabled={viewsBusy}
                >
                  <RotateCcw /> Reset to defaults
                </button>
                <button className="submit" disabled={viewsBusy || viewsProblems.length > 0}>
                  {viewsBusy ? (
                    <>
                      <RefreshCw className="spin" /> Saving…
                    </>
                  ) : (
                    'Save defaults'
                  )}
                </button>
              </div>
            </form>
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
              Edit the wording, colours, and logo shown in the sidebar. Defaults also live in{' '}
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
              <div className="color-row">
                {BRANDING_COLOR_FIELDS.map((field) => (
                  <div className="color-field" key={field}>
                    <label htmlFor={`brand-${field}`}>{COLOR_LABEL[field]}</label>
                    <div className="color-input">
                      <input
                        id={`brand-${field}`}
                        type="color"
                        value={normalizeHex(brandForm[field]) || DEFAULT_BRANDING[field]}
                        onChange={(e) => setBrandForm({ ...brandForm, [field]: e.target.value })}
                      />
                      <input
                        aria-label={`${COLOR_LABEL[field]} hex value`}
                        value={brandForm[field]}
                        maxLength={7}
                        spellCheck={false}
                        onChange={(e) => setBrandForm({ ...brandForm, [field]: e.target.value })}
                        required
                      />
                    </div>
                  </div>
                ))}
              </div>
              <ul className="contrast-list">
                {contrast.map((reading) => (
                  <li key={reading.field} className={reading.passes ? 'pass' : 'fail'}>
                    {reading.passes ? <CheckCircle2 /> : <AlertCircle />}
                    <span>{reading.label}</span>
                    <strong>
                      {reading.ratio}:1 · {reading.passes ? 'Passes AA' : 'Fails AA'}
                    </strong>
                  </li>
                ))}
              </ul>
              <label>
                Logo address (optional)
                <input
                  type="url"
                  value={brandForm.logoUrl}
                  maxLength={LOGO_URL_MAX}
                  placeholder="https://example.com/logo.png"
                  spellCheck={false}
                  onChange={(e) => setBrandForm({ ...brandForm, logoUrl: e.target.value })}
                />
              </label>
              <label>
                Logo alt text
                <input
                  value={brandForm.logoAlt}
                  maxLength={120}
                  placeholder="Describe the logo, e.g. GHolmes Designs logo"
                  disabled={!brandForm.logoUrl}
                  onChange={(e) => setBrandForm({ ...brandForm, logoAlt: e.target.value })}
                  required={Boolean(brandForm.logoUrl)}
                />
              </label>
              <p className="field-hint">
                A logo is referenced by address, never uploaded or copied into this device's
                database. Without one, the text mark is used.
              </p>
              {logoProblems.length > 0 && (
                <div className="inline-warning" role="alert">
                  <AlertCircle />
                  <div>
                    <strong>Logo needs one more thing</strong>
                    <span>{logoProblems.map((issue) => issue.message).join(' ')}</span>
                  </div>
                </div>
              )}
              <div className="brand-preview" style={brandStyle(brandForm)}>
                <BrandMark branding={brandForm} />
                <div>
                  <strong>{brandForm.title || DEFAULT_BRANDING.title}</strong>
                  <span>{brandForm.subtitle || DEFAULT_BRANDING.subtitle}</span>
                </div>
                <em>v{APP_VERSION}</em>
              </div>
              <div className="brand-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setBrandForm({ ...DEFAULT_BRANDING })}
                  disabled={brandBusy}
                >
                  <RotateCcw /> Reset to defaults
                </button>
                <button className="submit" disabled={brandBusy || brandProblems.length > 0}>
                  {brandBusy ? (
                    <>
                      <RefreshCw className="spin" /> Saving…
                    </>
                  ) : (
                    'Save branding'
                  )}
                </button>
              </div>
              {brandProblems.length > 0 && (
                <p className="field-hint" role="status">
                  Saving is blocked until every reading above passes AA.
                </p>
              )}
            </form>
          </section>
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
              names never create projects. OAuth uses the limited <code>drive.file</code> scope;
              existing folders are granted only through Google Picker. Tokens stay encrypted on the
              server and never reach the browser.
            </p>
            {driveError && (
              <div className="inline-warning" role="alert">
                <AlertCircle />
                <div>
                  <strong>Drive status unavailable</strong>
                  <span>{driveError}</span>
                </div>
              </div>
            )}
            {!driveError && !state?.configured && (
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
                {state.pickerConfigured ? (
                  <button
                    className="drive-picker-button"
                    type="button"
                    onClick={chooseRoot}
                    disabled={pickerBusy}
                  >
                    {pickerBusy
                      ? 'Opening Google Picker…'
                      : state.rootFolderId
                        ? 'Change root folder with Google Picker'
                        : 'Choose root folder with Google Picker'}
                  </button>
                ) : (
                  <div className="inline-warning">
                    <AlertCircle />
                    <div>
                      <strong>Picker not configured</strong>
                      <span>
                        Add <code>GOOGLE_API_KEY</code> and <code>GOOGLE_APP_ID</code> (Cloud
                        project number) to <code>.env</code>, enable the Google Picker API, then
                        restart.
                      </span>
                    </div>
                  </div>
                )}
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
                <p className="muted">
                  Disconnect removes credentials stored here only. After a cutover from the old
                  full-Drive grant, also revoke the app in{' '}
                  <a
                    href="https://myaccount.google.com/permissions"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Google Account permissions
                  </a>
                  , then reconnect with <code>drive.file</code>.
                </p>
              </>
            ) : (
              <button onClick={connect} disabled={!state?.configured}>
                Connect Google Drive
              </button>
            )}
          </section>
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
                <span className="eyebrow">Modules</span>
                <h2>Calendar</h2>
              </div>
            </div>
            <p>
              One month of Signal Campaign&rsquo;s scheduled content beside the tasks coming due,
              kept as two groups rather than one merged list. It reads and never writes — content is
              scheduled in Signal, not here.
            </p>
            <div className="module-list">
              <Link to="/calendar">
                <CalendarDays /> Open the calendar
              </Link>
            </div>
            <p className="field-hint">
              Campaign playbook import has shipped too — it lives in the sidebar under{' '}
              <Link to="/import">Import</Link>. So has read-only Drive browsing, under{' '}
              <Link to="/files">Files</Link>; it lists and opens files and never uploads, renames,
              moves, or deletes one.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

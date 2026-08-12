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
  Pencil,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { api, send } from '../api';
import type { Category, Project, Tag, Task } from '../../../shared/types';
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
import { normalizeHex } from '../../../shared/contrast';
import { BrandMark, DriveBadge } from './Primitives';
import { PageHead } from './Shell';
import { brandStyle } from './ui-shared';
import { CategoriesCard } from './CategoriesCard';
import { TagsCard } from './TagsCard';

const COLOR_LABEL: Record<BrandingColorField, string> = {
  background: 'Sidebar background',
  foreground: 'Sidebar text',
  accent: 'Accent',
};

export function SettingsView({
  branding,
  tags,
  tasks,
  categories,
  projects,
  refresh,
  flash,
}: {
  branding: Branding;
  tags: Tag[];
  tasks: Task[];
  categories: Category[];
  projects: Project[];
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
    [brandBusy, setBrandBusy] = useState(false),
    [driveError, setDriveError] = useState('');
  const load = useCallback(async () => {
    const next = await api<{
      configured: boolean;
      connected: boolean;
      rootFolderId?: string;
      rootFolderUrl?: string;
    }>('/settings/drive');
    setState(next);
    setDriveError('');
  }, []);
  useEffect(() => {
    void load().catch((error: unknown) => setDriveError((error as Error).message));
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
              A logo is referenced by address, never uploaded or copied into this device's database.
              Without one, the text mark is used.
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
        <CategoriesCard
          categories={categories}
          projects={projects}
          refresh={refresh}
          flash={flash}
        />
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
              <h2>Calendar & files</h2>
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
          </div>
          <p className="field-hint">
            Campaign playbook import has shipped — it lives in the sidebar under{' '}
            <Link to="/import">Import</Link>.
          </p>
        </section>
      </div>
    </>
  );
}

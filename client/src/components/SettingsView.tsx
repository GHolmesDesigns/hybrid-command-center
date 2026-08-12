import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Clock3,
  ExternalLink,
  FileText,
  FolderKanban,
  Pencil,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { api, send } from '../api';
import type { Tag, Task } from '../../../shared/types';
import { APP_VERSION, type Branding } from '../../../shared/branding';
import { DriveBadge } from './Primitives';
import { PageHead } from './Shell';
import { TagsCard } from './TagsCard';

export function SettingsView({
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

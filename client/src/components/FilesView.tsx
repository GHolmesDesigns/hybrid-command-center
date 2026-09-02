import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  ExternalLink,
  File,
  Folder,
  Lock,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { api } from '../api';
import type { Project } from '../../../shared/types';
import {
  DRIVE_PAGE_SIZE,
  driveFileKind,
  formatFileSize,
  isDriveFolder,
  type DriveFile,
  type DriveListing,
} from '../../../shared/drive';
import { formatDateTime } from './formatting';
import { Empty } from './Primitives';
import { PageHead } from './Shell';

/** One request for a page of a folder. `folderId` omitted means the project's own folder. */
const listingPath = (projectId: string, folderId: string, pageToken?: string) => {
  const query = new URLSearchParams({ pageSize: String(DRIVE_PAGE_SIZE) });
  if (folderId) query.set('folderId', folderId);
  if (pageToken) query.set('pageToken', pageToken);
  return `/projects/${projectId}/files?${query}`;
};

/**
 * The Files module: read-only browsing of one project's Drive folder (FR8, decision §5.8).
 *
 * A page rather than a modal, as the card invited: a paginated list with a folder switcher
 * is cramped in a dialog on a small screen, and this one is worth linking to — the project
 * and folder both live in the address, so a particular folder can be reloaded or handed to
 * someone else. `/files?project=<id>` matches the `?project=` convention the Status board
 * already uses.
 *
 * Nothing here writes. There is no upload, download, move, rename, or delete control, and
 * the API this reads has no counterpart that would accept one — every change to a file
 * happens in Drive, which is one click away on every row.
 */
export function FilesView({
  projects,
  defaultProject,
  remember,
}: {
  projects: Project[];
  /** The last project the user opened, used when the address does not name one. */
  defaultProject?: string;
  remember: (id: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const browsable = projects.filter((project) => project.status !== 'ARCHIVED');
  const requested = params.get('project') || '';
  const selected =
    browsable.find((project) => project.id === requested)?.id ??
    browsable.find((project) => project.id === defaultProject)?.id ??
    browsable[0]?.id ??
    '';
  const folderId = params.get('folder') || '';
  const project = projects.find((candidate) => candidate.id === selected);

  const [listing, setListing] = useState<DriveListing | null>(null);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState('');
  const [folderName, setFolderName] = useState('');
  const [writeBusy, setWriteBusy] = useState(false);
  /** Bumped by "Try again", which is the only way to ask for the same listing twice. */
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((count) => count + 1);

  useEffect(() => {
    if (selected) remember(selected);
  }, [selected, remember]);

  /**
   * The first page of whatever project and folder the address currently names, and again
   * whenever "Try again" bumps `attempt`. A reply is dropped if the selection changed while
   * it was in flight, so switching folders twice quickly cannot leave the slower answer on
   * screen under the newer folder's name.
   */
  useEffect(() => {
    if (!selected) {
      setListing(null);
      setFiles([]);
      return;
    }
    let current = true;
    setLoading(true);
    setError('');
    api<DriveListing>(listingPath(selected, folderId))
      .then((next) => {
        if (!current) return;
        setListing(next);
        setFiles(next.files);
      })
      .catch((problem: Error) => {
        if (!current) return;
        setListing(null);
        setFiles([]);
        setError(problem.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [attempt, folderId, selected]);

  /**
   * The next page, appended. Drive's cursor is forward-only, so this grows the list rather
   * than replacing it — going back is scrolling up, not a request that cannot be made.
   */
  const more = async () => {
    if (!listing?.nextPageToken) return;
    setPaging(true);
    setError('');
    try {
      const next = await api<DriveListing>(listingPath(selected, folderId, listing.nextPageToken));
      setListing(next);
      setFiles((current) => [...current, ...next.files]);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setPaging(false);
    }
  };

  const choose = (key: 'project' | 'folder', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // A folder belongs to the project it was opened from, so changing project drops it.
    if (key === 'project') next.delete('folder');
    setParams(next);
  };

  const createFolder = async () => {
    if (!listing?.folder || !folderName.trim()) return;
    setWriteBusy(true);
    setError('');
    try {
      const preview = await api<{ plan: unknown; planHash: string; confirmation: string }>(
        `/projects/${selected}/drive-write/folder/preview`,
        { method: 'POST', body: JSON.stringify({ parentId: listing.folder.id, name: folderName }) },
      );
      if (!window.confirm(preview.confirmation)) return;
      await api(`/projects/${selected}/drive-write/folder`, {
        method: 'POST',
        body: JSON.stringify(preview),
      });
      setFolderName('');
      retry();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setWriteBusy(false);
    }
  };

  const uploadFile = async (file: File) => {
    if (!listing?.folder) return;
    setWriteBusy(true);
    setError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const preview = await api<{ plan: unknown; planHash: string; confirmation: string }>(
        `/projects/${selected}/drive-write/upload/preview`,
        {
          method: 'POST',
          body: JSON.stringify({
            folderId: listing.folder.id,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            contentBase64: btoa(binary),
          }),
        },
      );
      if (!window.confirm(preview.confirmation)) return;
      await api(`/projects/${selected}/drive-write/upload`, {
        method: 'POST',
        body: JSON.stringify(preview),
      });
      retry();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setWriteBusy(false);
    }
  };

  const scopes = listing?.scopes ?? [];
  const ready = listing?.state === 'READY';

  if (!browsable.length)
    return (
      <>
        <PageHead
          eyebrow="Integrations"
          title="Files"
          body="Browse the Drive folder behind a project, without leaving Command Center."
        />
        <Empty
          title="No projects to browse"
          body="Create a project first. Its Drive folder is provisioned with it, and its files appear here."
          action={
            <Link className="buttonlike" to="/projects">
              Go to Projects
            </Link>
          }
        />
      </>
    );

  return (
    <>
      <PageHead
        eyebrow="Integrations"
        title="Files"
        body={
          ready
            ? `${files.length} item${files.length === 1 ? '' : 's'} in ${listing?.folder?.name ?? 'this folder'}${listing?.nextPageToken ? ', more available' : ''}.`
            : 'Browse the Drive folder behind a project, without leaving Command Center.'
        }
        action={
          listing?.folder?.url && (
            <a
              className="secondary buttonlike"
              href={listing.folder.url}
              target="_blank"
              rel="noreferrer"
            >
              Open in Drive <ExternalLink />
            </a>
          )
        }
      />

      <div className="board-filters">
        <label>
          <span>Project</span>
          <select value={selected} onChange={(event) => choose('project', event.target.value)}>
            {browsable.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Folder</span>
          <select
            value={folderId}
            disabled={scopes.length === 0}
            onChange={(event) => choose('folder', event.target.value)}
          >
            {scopes.length === 0 ? (
              <option value="">No Drive folder</option>
            ) : (
              scopes.map((scope, index) => (
                <option key={scope.id} value={index === 0 ? '' : scope.id}>
                  {scope.name}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      {ready && listing?.folder && (
        <div className="files-write" aria-label="Confirmed Drive writes">
          <label>
            <span>New folder in {listing.folder.name}</span>
            <input
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder="Folder name"
              maxLength={200}
              disabled={writeBusy}
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={createFolder}
            disabled={writeBusy || !folderName.trim()}
          >
            <Plus /> Create folder
          </button>
          <label className="buttonlike secondary">
            <Upload /> Upload file
            <input
              type="file"
              hidden
              disabled={writeBusy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void uploadFile(file);
              }}
            />
          </label>
        </div>
      )}

      <p className="files-note">
        <Lock /> Browsing is read-only. Folder creation and uploads are separate confirmed actions;
        downloads, moves, renames, and deletes remain unavailable.
      </p>

      {loading && (
        <p className="files-status" role="status">
          <RefreshCw className="spin" /> Loading files from Drive…
        </p>
      )}

      {!loading && error && (
        <StatePanel
          title="Files are unavailable"
          body={error}
          action={
            <button type="button" className="secondary" onClick={retry}>
              <RefreshCw /> Try again
            </button>
          }
        />
      )}

      {!loading && !error && listing && !ready && (
        <UnreadyState listing={listing} project={project} retry={retry} />
      )}

      {!loading && files.length > 0 && (
        <FileTable files={files} scopes={scopes} open={(id) => choose('folder', id)} />
      )}

      {!loading && ready && files.length === 0 && (
        <Empty
          compact
          title="This folder is empty"
          body="Nothing has been put in it yet. Add files in Drive and they show up here."
          action={
            listing?.folder?.url ? (
              <a
                className="buttonlike secondary"
                href={listing.folder.url}
                target="_blank"
                rel="noreferrer"
              >
                Open in Drive <ExternalLink />
              </a>
            ) : undefined
          }
        />
      )}

      {listing?.nextPageToken && (
        <div className="files-more">
          <button type="button" className="secondary" onClick={more} disabled={paging}>
            {paging ? (
              <>
                <RefreshCw className="spin" /> Loading…
              </>
            ) : (
              `Show ${DRIVE_PAGE_SIZE} more`
            )}
          </button>
          <span className="field-hint">Showing the first {files.length} items in this folder.</span>
        </div>
      )}
    </>
  );
}

/**
 * Every way a listing can fail to be a listing, each with the step that resolves it.
 * They are deliberately four different messages: "no credentials on this machine",
 * "credentials but not connected", "connected but this project has no folder", and "the
 * call failed" need four different actions, and one shared "Drive unavailable" would
 * leave the user guessing which of them they are in.
 */
function UnreadyState({
  listing,
  project,
  retry,
}: {
  listing: DriveListing;
  project?: Project;
  retry: () => void;
}) {
  const settings = (
    <Link className="buttonlike secondary" to="/settings">
      Open Settings
    </Link>
  );
  if (listing.state === 'NOT_CONFIGURED')
    return (
      <StatePanel
        title="Google Drive is not set up on this computer"
        body="Add Google OAuth credentials and a token encryption key to .env, restart the API, then connect Drive in Settings. Nothing can be read from Drive until then."
        action={settings}
      />
    );
  if (listing.state === 'NOT_CONNECTED')
    return (
      <StatePanel
        title="Google Drive is not connected"
        body="Connect your Google account in Settings and choose a Command Center root folder. Your projects and tasks are unaffected either way."
        action={settings}
      />
    );
  if (listing.state === 'NO_FOLDER')
    return (
      <StatePanel
        title={`${listing.projectName} has no Drive folder yet`}
        body={
          project?.driveError ||
          'Run Sync to Folder on the dashboard to provision this project’s folder skeleton, then come back. No file is created, moved, or deleted by that sync.'
        }
        action={
          <Link className="buttonlike secondary" to="/">
            Go to the dashboard
          </Link>
        }
      />
    );
  return (
    <StatePanel
      title="Drive could not list this folder"
      body={listing.error || 'Drive did not say why. The folder and your connection are unchanged.'}
      action={
        <button type="button" className="secondary" onClick={retry}>
          <RefreshCw /> Try again
        </button>
      }
    />
  );
}

function StatePanel({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="inline-warning files-state" role="alert">
      <AlertCircle />
      <div>
        <strong>{title}</strong>
        <span>{body}</span>
        {action && <div className="files-state-action">{action}</div>}
      </div>
    </div>
  );
}

/**
 * The listing itself. A folder row opens here when it is one of this project's own
 * folders, and in Drive otherwise — a project's file browser stays inside that project,
 * so anything deeper is Drive's job.
 */
function FileTable({
  files,
  scopes,
  open,
}: {
  files: DriveFile[];
  scopes: DriveListing['scopes'];
  open: (folderId: string) => void;
}) {
  return (
    <div className="files-table-wrap">
      <table className="files-table">
        <caption className="sr-only">Files in this Drive folder</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Modified</th>
            <th scope="col">Size</th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => {
            const folder = isDriveFolder(file);
            const browsable = folder && scopes.some((scope) => scope.id === file.id);
            return (
              <tr key={file.id}>
                <th scope="row">
                  <span className={`file-icon ${folder ? 'folder' : ''}`}>
                    {folder ? <Folder /> : <File />}
                  </span>
                  {browsable ? (
                    <button type="button" className="text-btn" onClick={() => open(file.id)}>
                      {file.name}
                    </button>
                  ) : (
                    <span>{file.name}</span>
                  )}
                </th>
                <td>{driveFileKind(file.mimeType)}</td>
                <td>{file.modifiedAt ? formatDateTime(file.modifiedAt) : '—'}</td>
                <td className="files-size">{formatFileSize(file.size)}</td>
                <td>
                  <a
                    className="file-open"
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${file.name} in Drive`}
                  >
                    Open <ExternalLink />
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

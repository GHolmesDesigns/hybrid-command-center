import type { Db } from '../db.ts';
import { PROJECT_SUBFOLDERS, config } from '../config.ts';
import { createGoogleProvider } from './google.ts';
import { decryptJson, encryptJson } from './tokens.ts';
import { DisconnectedDriveProvider, type DriveProvider } from './provider.ts';

const now = () => new Date().toISOString();
export function getSetting(db: Db, key: string) {
  return (
    db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
  )?.value;
}
export function setSetting(db: Db, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value, now());
}

export function driveProvider(db: Db): DriveProvider {
  const encrypted = getSetting(db, 'google_tokens');
  if (
    !encrypted ||
    !config.google.clientId ||
    !config.google.clientSecret ||
    !config.google.encryptionKey
  )
    return new DisconnectedDriveProvider();
  const tokens = decryptJson(encrypted, config.google.encryptionKey);
  const { provider, auth } = createGoogleProvider(tokens, config.google);
  auth.on('tokens', (fresh) =>
    setSetting(
      db,
      'google_tokens',
      encryptJson({ ...tokens, ...fresh }, config.google.encryptionKey),
    ),
  );
  return provider;
}

export async function provisionClient(db: Db, clientId: string, provider = driveProvider(db)) {
  const client = db
    .prepare('SELECT id,name,drive_folder_id FROM clients WHERE id=?')
    .get(clientId) as any;
  if (!client) throw new Error('Client not found.');
  if (client.drive_folder_id) return client.drive_folder_id as string;
  if (!provider.connected) {
    db.prepare("UPDATE clients SET drive_status='DISCONNECTED',drive_error=NULL WHERE id=?").run(
      clientId,
    );
    return undefined;
  }
  const rootId = getSetting(db, 'drive_root_id');
  if (!rootId) {
    db.prepare(
      "UPDATE clients SET drive_status='PENDING',drive_error='Select a Command Center root folder in Settings.' WHERE id=?",
    ).run(clientId);
    return undefined;
  }
  db.prepare("UPDATE clients SET drive_status='PENDING',drive_error=NULL WHERE id=?").run(clientId);
  try {
    const folder = await provider.ensureFolder({
      name: client.name,
      parentId: rootId,
      idempotencyKey: `client:${client.id}`,
    });
    db.prepare(
      "UPDATE clients SET drive_folder_id=?,drive_folder_url=?,drive_status='CONNECTED',drive_error=NULL,updated_at=? WHERE id=?",
    ).run(folder.id, folder.url, now(), clientId);
    return folder.id;
  } catch (error) {
    db.prepare(
      "UPDATE clients SET drive_status='FAILED',drive_error=?,updated_at=? WHERE id=?",
    ).run(message(error), now(), clientId);
    throw error;
  }
}

export async function provisionProject(db: Db, projectId: string, provider = driveProvider(db)) {
  const project = db
    .prepare(
      `SELECT p.id,p.name,p.drive_folder_id,p.client_id,c.drive_folder_id client_folder_id
    FROM projects p JOIN clients c ON c.id=p.client_id WHERE p.id=?`,
    )
    .get(projectId) as any;
  if (!project) throw new Error('Project not found.');
  if (!provider.connected) {
    db.prepare("UPDATE projects SET drive_status='DISCONNECTED',drive_error=NULL WHERE id=?").run(
      projectId,
    );
    return;
  }
  const clientFolderId =
    project.client_folder_id || (await provisionClient(db, project.client_id, provider));
  if (!clientFolderId) {
    db.prepare(
      "UPDATE projects SET drive_status='PENDING',drive_error='Client Drive folder is not ready.' WHERE id=?",
    ).run(projectId);
    return;
  }
  db.prepare("UPDATE projects SET drive_status='PENDING',drive_error=NULL WHERE id=?").run(
    projectId,
  );
  try {
    let projectFolderId = project.drive_folder_id as string | undefined;
    if (!projectFolderId) {
      const folder = await provider.ensureFolder({
        name: project.name,
        parentId: clientFolderId,
        idempotencyKey: `project:${project.id}`,
      });
      projectFolderId = folder.id;
      db.prepare(
        'UPDATE projects SET drive_folder_id=?,drive_folder_url=?,updated_at=? WHERE id=?',
      ).run(folder.id, folder.url, now(), projectId);
    }
    for (const name of PROJECT_SUBFOLDERS) {
      const previous = db
        .prepare(
          "SELECT folder_id FROM drive_steps WHERE entity_type='project' AND entity_id=? AND step_key=?",
        )
        .get(projectId, name);
      if (previous) continue;
      const folder = await provider.ensureFolder({
        name,
        parentId: projectFolderId,
        idempotencyKey: `project:${project.id}:${name}`,
      });
      db.prepare(
        "INSERT OR IGNORE INTO drive_steps(entity_type,entity_id,step_key,folder_id,folder_url,created_at) VALUES('project',?,?,?,?,?)",
      ).run(projectId, name, folder.id, folder.url, now());
    }
    db.prepare(
      "UPDATE projects SET drive_status='CONNECTED',drive_error=NULL,updated_at=? WHERE id=?",
    ).run(now(), projectId);
  } catch (error) {
    db.prepare(
      "UPDATE projects SET drive_status='FAILED',drive_error=?,updated_at=? WHERE id=?",
    ).run(message(error), now(), projectId);
    throw error;
  }
}

/** Provision Drive folders for every active client/project. Never deletes or renames Drive files. */
export async function syncAllToDrive(db: Db, provider = driveProvider(db)) {
  const clients = db
    .prepare("SELECT id, name FROM clients WHERE status='ACTIVE' ORDER BY name")
    .all() as { id: string; name: string }[];
  const projects = db
    .prepare("SELECT id, name FROM projects WHERE status NOT IN ('ARCHIVED') ORDER BY name")
    .all() as { id: string; name: string }[];
  const clientResults: { id: string; name: string; ok: boolean; error?: string }[] = [];
  const projectResults: { id: string; name: string; ok: boolean; error?: string }[] = [];

  if (!provider.connected) {
    return {
      connected: false,
      message: 'Connect Google Drive and choose a root folder in Settings before syncing.',
      clients: clientResults,
      projects: projectResults,
    };
  }
  if (!getSetting(db, 'drive_root_id')) {
    return {
      connected: true,
      message: 'Select a Command Center root folder in Settings before syncing.',
      clients: clientResults,
      projects: projectResults,
    };
  }

  for (const client of clients) {
    try {
      await provisionClient(db, client.id, provider);
      clientResults.push({ id: client.id, name: client.name, ok: true });
    } catch (error) {
      clientResults.push({ id: client.id, name: client.name, ok: false, error: message(error) });
    }
  }
  for (const project of projects) {
    try {
      await provisionProject(db, project.id, provider);
      projectResults.push({ id: project.id, name: project.name, ok: true });
    } catch (error) {
      projectResults.push({ id: project.id, name: project.name, ok: false, error: message(error) });
    }
  }

  const failed = [...clientResults, ...projectResults].filter((r) => !r.ok).length;
  return {
    connected: true,
    message: failed
      ? `Sync finished with ${failed} issue${failed === 1 ? '' : 's'}. Local records were not removed.`
      : `Synced ${clientResults.length} client${clientResults.length === 1 ? '' : 's'} and ${projectResults.length} project${projectResults.length === 1 ? '' : 's'} to Drive.`,
    clients: clientResults,
    projects: projectResults,
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 500) : 'Unknown Drive error';

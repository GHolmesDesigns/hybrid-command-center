import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { PROJECT_SUBFOLDERS } from '../config.ts';
import { MockDriveMediaProvider, MockDriveProvider } from '../drive/mock-provider.ts';
import { provisionClient, provisionProject, setSetting } from '../drive/service.ts';
import { projectScopes } from '../drive/browse.ts';
import { previewClientMerge } from '../client-merge.ts';
import { previewPlaybook } from '../import.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { listMcpAgentEvents } from './events.ts';
import { createMcpSession } from './session.ts';
import { callIntegrationTool } from './integration-tools.ts';
import { callWorkspaceWriteTool } from './workspace-write.ts';
import { AnalyticsWindowService } from '../publish/analytics-window.ts';
import { BufferAccountsService } from '../publish/buffer-accounts.ts';
import { ProviderInventoryService } from '../publish/inventory.ts';
import {
  MockAnalyticsWindowProvider,
  MockBufferReadProvider,
  MockProviderInventoryProvider,
} from '../publish/mock-provider.ts';
import {
  COORDINATION_WRITE_LIMIT_PER_MINUTE,
  INTEGRATION_WRITE_LIMIT_PER_MINUTE,
} from '../../shared/mcp-agent-events.ts';
import { RollingWindowLimiter } from './rate-limit.ts';
import { findWriteMutation } from './write-mutations.ts';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

const session = () => createMcpSession({ agentLabel: 'codex' });

const stamp = '2026-08-29T12:00:00.000Z';

function seedClients() {
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const destinationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES(?,?,'source','ACTIVE','DISCONNECTED',?,?)`,
  ).run(sourceId, 'Source Co', stamp, stamp);
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES(?,?,'destination','ACTIVE','DISCONNECTED',?,?)`,
  ).run(destinationId, 'Destination Co', stamp, stamp);
  return { sourceId, destinationId };
}

function seedProject() {
  const clientId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES(?,?,'client','ACTIVE','PENDING',?,?)`,
  ).run(clientId, 'Client', stamp, stamp);
  db.prepare(
    `INSERT INTO projects(id,client_id,name,status,priority,drive_status,created_at,updated_at)
     VALUES(?,?,'Spring','ACTIVE','HIGH','PENDING',?,?)`,
  ).run(projectId, clientId, stamp, stamp);
  setSetting(db, 'drive_root_id', 'root');
  return { clientId, projectId };
}

const playbookText = (client = 'Acme Studio') =>
  [
    '[Clients]',
    'client_key\tname\tcontact_name\temail\tphone\twebsite\tnotes',
    `CLI-A\t${client}\tDana Holmes\tdana@example.com\t\thttps://example.com\tRetainer`,
    '[Projects]',
    'project_key\tclient_key\tname\tstatus\tpriority\tstart_date\ttarget_deadline\tdescription\tnotes\tposition',
    'PRJ-A\tCLI-A\tSpring Campaign\tACTIVE\tHIGH\t2026-03-01\t2026-04-30\tSix weeks\t\t1',
    '[Tasks]',
    'task_key\tproject_key\ttitle\ttask_type\tstatus\tpriority\tstart_date\tdue_date\tdescription\tnotes\tposition',
    'TSK-1\tPRJ-A\tWeek 1 blog post\tBLOG_POST\tTODO\tHIGH\t\t2026-03-02',
    '[ChecklistItems]',
    'task_key\titem_order\ttitle\tcompleted',
    '[Dependencies]',
    'task_key\tprerequisite_task_key',
  ].join('\n');

const signalImportText = (caption = 'Hello from MCP') =>
  `[SignalPosts]
post_key	text	channels	date	time	format	status	campaigns	cta	post_import_source	post_import_id
POST-1	${caption}	ig		09:00	TEXT	DRAFT	NONE	NONE		
[SignalMedia]
post_key	media_order	source	url
`;

describe('MCP integration tools', () => {
  it('refuses merge commit when planHash no longer matches', async () => {
    const { sourceId, destinationId } = seedClients();
    const preview = previewClientMerge(db, sourceId, destinationId);
    db.prepare('UPDATE clients SET name=?, updated_at=? WHERE id=?').run(
      'Destination Renamed',
      stamp,
      destinationId,
    );
    const result = await callIntegrationTool(db, session(), 'workspace_merge_clients_commit', {
      clientRequestId: 'merge-stale',
      sourceId,
      destinationId,
      planHash: preview.planHash,
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.error).toMatch(/changed since this merge was previewed/i);
    expect(listMcpAgentEvents(db, { tool: 'workspace_merge_clients_commit' })[0]?.outcome).toBe(
      'REFUSED',
    );
  });

  it('refuses playbook commit when fingerprint no longer matches', async () => {
    const preview = previewPlaybook(db, { text: playbookText() });
    const result = await callIntegrationTool(db, session(), 'import_playbook_commit', {
      clientRequestId: 'playbook-stale',
      text: playbookText('Different Client'),
      fingerprint: preview.fingerprint,
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.error).toMatch(/changed since it was previewed/i);
  });

  it('refuses signal import commit when fingerprint no longer matches', async () => {
    const media = new MockDriveMediaProvider();
    const preview = await callIntegrationTool(
      db,
      session(),
      'import_signal_preview',
      { text: signalImportText() },
      { driveMedia: media },
    );
    expect(preview.outcome).toBe('SUCCESS');
    const fingerprint = (preview.data as { fingerprint: string }).fingerprint;
    const result = await callIntegrationTool(
      db,
      session(),
      'import_signal_commit',
      {
        clientRequestId: 'signal-stale',
        text: signalImportText('Different caption'),
        fingerprint,
      },
      { driveMedia: media },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.error).toMatch(/changed since it was previewed/i);
  });

  it('keeps integration and coordination write budgets separate', async () => {
    const mcp = session();
    mcp.integrationWrites = new RollingWindowLimiter(INTEGRATION_WRITE_LIMIT_PER_MINUTE, 60_000);
    mcp.coordinationWrites = new RollingWindowLimiter(COORDINATION_WRITE_LIMIT_PER_MINUTE, 60_000);
    const now = new Date('2026-08-29T12:00:00.000Z');
    const drive = new MockDriveProvider();
    drive.connected = false;

    for (let i = 0; i < INTEGRATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      const ok = await callIntegrationTool(
        db,
        mcp,
        'drive_sync',
        { clientRequestId: `int-${i}` },
        { now, drive },
      );
      expect(ok.outcome).toBe('SUCCESS');
    }
    const refusedIntegration = await callIntegrationTool(
      db,
      mcp,
      'drive_sync',
      { clientRequestId: 'int-over' },
      { now, drive },
    );
    expect(refusedIntegration.outcome).toBe('REFUSED');
    expect(refusedIntegration.error).toMatch(/6 per rolling minute/);

    const clientId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,'acme','ACTIVE','DISCONNECTED',?,?)`,
    ).run(clientId, 'Acme', stamp, stamp);
    const local = await callWorkspaceWriteTool(
      db,
      mcp,
      'workspace_create_project',
      {
        clientRequestId: 'coord-still-ok',
        clientId,
        name: 'Still works',
        status: 'ACTIVE',
        priority: 'MEDIUM',
      },
      { now },
    );
    expect(local.outcome).toBe('SUCCESS');

    while (mcp.coordinationWrites.tryConsume(now.getTime())) {
      /* drain remaining coordination budget */
    }
    const refusedCoord = await callWorkspaceWriteTool(
      db,
      mcp,
      'workspace_create_project',
      {
        clientRequestId: 'coord-over',
        clientId,
        name: 'Blocked',
        status: 'ACTIVE',
        priority: 'MEDIUM',
      },
      { now },
    );
    expect(refusedCoord.outcome).toBe('REFUSED');
    expect(refusedCoord.error).toMatch(/10 per rolling minute/);

    // Integration budget is still exhausted in this window; only a rolled window recovers it.
    const stillBlocked = await callIntegrationTool(
      db,
      mcp,
      'drive_sync',
      { clientRequestId: 'int-still-blocked' },
      { now, drive },
    );
    expect(stillBlocked.outcome).toBe('REFUSED');

    const recovered = await callIntegrationTool(
      db,
      mcp,
      'drive_sync',
      { clientRequestId: 'int-after-window' },
      { now: new Date(now.getTime() + 60_001), drive },
    );
    expect(recovered.outcome).toBe('SUCCESS');
  });

  it('refuses files_browse_project for a folder outside project scopes', async () => {
    const { clientId, projectId } = seedProject();
    const drive = new MockDriveProvider();
    await provisionClient(db, clientId, drive);
    await provisionProject(db, projectId, drive);
    expect(projectScopes(db, projectId).length).toBe(1 + PROJECT_SUBFOLDERS.length);

    const result = await callIntegrationTool(
      db,
      session(),
      'files_browse_project',
      { projectId, folderId: 'not-a-project-folder' },
      { drive },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.error).toMatch(/not part of this project/i);
  });

  it('resolves Drive media metadata without opening bytes', async () => {
    const fileId = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const media = new MockDriveMediaProvider();
    media.seed(fileId, { name: 'hero.png', mimeType: 'image/png', size: '4096' });
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_resolve_drive_media',
      {
        clientRequestId: 'resolve-1',
        link: `https://drive.google.com/file/d/${fileId}/view`,
      },
      { driveMedia: media },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect(media.calls).toEqual([fileId]);
    expect(media.openCalls).toEqual([]);
    expect((result.data as { driveFileId: string }).driveFileId).toBe(fileId);
  });

  it('leaves prior inventory generation when refresh fails', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.hold([
      {
        providerPostId: 'kept-1',
        state: 'SCHEDULED',
        scheduledInstant: '2026-08-30T13:00:00.000Z',
        captionExcerpt: 'Prior generation',
        accountIds: [1],
      },
    ]);
    const inventory = new ProviderInventoryService(
      db,
      provider,
      () => new Date('2026-08-29T12:00:00.000Z'),
    );
    const first = await inventory.refresh();
    expect(first.entries.map((e) => e.providerPostId)).toEqual(['kept-1']);

    provider.pages = [];
    provider.failureAt = 1;
    provider.failure = new Error('provider down');
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_refresh_provider_inventory',
      { clientRequestId: 'inv-fail' },
      { inventory },
    );
    expect(result.outcome).toBe('SUCCESS');
    const data = result.data as { entries: { providerPostId: string }[]; reason?: string };
    expect(data.entries.map((e) => e.providerPostId)).toEqual(['kept-1']);
    expect(data.reason).toMatch(/could not be read|provider down/i);
  });

  it('lists integration activity without writing mcp_agent_events', async () => {
    const before = listMcpAgentEvents(db).length;
    const result = await callIntegrationTool(db, session(), 'integration_list_activity', {
      limit: 5,
    });
    expect(result.outcome).toBe('SUCCESS');
    expect(listMcpAgentEvents(db).length).toBe(before);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('records drive.sync on the integration log', async () => {
    seedProject();
    const drive = new MockDriveProvider();
    drive.connected = false;
    const result = await callIntegrationTool(
      db,
      session(),
      'drive_sync',
      { clientRequestId: 'sync-1' },
      { drive },
    );
    expect(result.outcome).toBe('SUCCESS');
    const events = listIntegrationEvents(db, { source: 'google-drive' });
    expect(events.some((e) => e.operation === 'drive.sync' && e.outcome === 'FAILURE')).toBe(true);
  });

  it('previews and commits a client merge', async () => {
    const { sourceId, destinationId } = seedClients();
    const preview = await callIntegrationTool(db, session(), 'workspace_merge_clients_preview', {
      sourceId,
      destinationId,
      fields: { name: { choice: 'SOURCE' } },
    });
    expect(preview.outcome).toBe('SUCCESS');
    const planHash = (preview.data as { planHash: string }).planHash;

    const commit = await callIntegrationTool(db, session(), 'workspace_merge_clients_commit', {
      clientRequestId: 'merge-ok',
      sourceId,
      destinationId,
      fields: { name: { choice: 'SOURCE' } },
      planHash,
    });
    expect(commit.outcome).toBe('SUCCESS');
    expect((commit.data as { destination: { id: string; name: string } }).destination.name).toBe(
      'Source Co',
    );
    const source = db.prepare('SELECT status FROM clients WHERE id=?').get(sourceId) as {
      status: string;
    };
    expect(source.status).toBe('ARCHIVED');
  });

  it('previews and commits a playbook import', async () => {
    const text = playbookText('Playbook Studio');
    const preview = await callIntegrationTool(db, session(), 'import_playbook_preview', { text });
    expect(preview.outcome).toBe('SUCCESS');
    const fingerprint = (preview.data as { fingerprint: string }).fingerprint;

    const commit = await callIntegrationTool(db, session(), 'import_playbook_commit', {
      clientRequestId: 'playbook-ok',
      text,
      fingerprint,
    });
    expect(commit.outcome).toBe('SUCCESS');
    expect((commit.data as { receipt: { outcome: string } }).receipt.outcome).toBe('COMMITTED');
    const clients = db.prepare(`SELECT name FROM clients WHERE name=?`).all('Playbook Studio');
    expect(clients).toHaveLength(1);
  });

  it('previews and commits a Signal import with MockDriveMediaProvider', async () => {
    const media = new MockDriveMediaProvider();
    const text = signalImportText('Imported caption');
    const preview = await callIntegrationTool(
      db,
      session(),
      'import_signal_preview',
      { text },
      { driveMedia: media },
    );
    expect(preview.outcome).toBe('SUCCESS');
    const fingerprint = (preview.data as { fingerprint: string }).fingerprint;

    const commit = await callIntegrationTool(
      db,
      session(),
      'import_signal_commit',
      { clientRequestId: 'signal-ok', text, fingerprint },
      { driveMedia: media },
    );
    expect(commit.outcome).toBe('SUCCESS');
    expect((commit.data as { receipt: { outcome: string } }).receipt.outcome).toBe('COMMITTED');
    const posts = db.prepare(`SELECT text FROM signal_posts WHERE text=?`).all('Imported caption');
    expect(posts).toHaveLength(1);
  });

  it('refuses writes when agent_label is missing', async () => {
    const drive = new MockDriveProvider();
    drive.connected = false;
    const result = await callIntegrationTool(
      db,
      createMcpSession({ agentLabel: null }),
      'drive_sync',
      { clientRequestId: 'no-label' },
      { drive },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_AGENT_LABEL_REQUIRED');
  });

  it('replays the same clientRequestId without double-writing', async () => {
    seedProject();
    const drive = new MockDriveProvider();
    drive.connected = false;
    const mcp = session();
    const first = await callIntegrationTool(
      db,
      mcp,
      'drive_sync',
      { clientRequestId: 'sync-idem' },
      { drive },
    );
    expect(first.outcome).toBe('SUCCESS');
    const eventsAfterFirst = listIntegrationEvents(db, { source: 'google-drive' }).filter(
      (e) => e.operation === 'drive.sync',
    ).length;

    const second = await callIntegrationTool(
      db,
      mcp,
      'drive_sync',
      { clientRequestId: 'sync-idem' },
      { drive },
    );
    expect(second.outcome).toBe('SUCCESS');
    expect(second.data).toEqual(first.data);
    expect(
      listIntegrationEvents(db, { source: 'google-drive' }).filter(
        (e) => e.operation === 'drive.sync',
      ),
    ).toHaveLength(eventsAfterFirst);
    expect(findWriteMutation(db, 'codex', 'sync-idem', 'drive_sync')?.result).toEqual(first.data);
  });

  it('fails unknown integration tool names', async () => {
    const result = await callIntegrationTool(db, session(), 'not_a_real_tool', {
      clientRequestId: 'x',
    });
    expect(result.outcome).toBe('FAILURE');
    expect(result.errorDetail?.code).toBe('COORDINATION_UNKNOWN_TOOL');
    expect(result.error).toMatch(/Unknown integration tool/);
  });

  it('browses a provisioned project folder', async () => {
    const { clientId, projectId } = seedProject();
    const drive = new MockDriveProvider();
    await provisionClient(db, clientId, drive);
    await provisionProject(db, projectId, drive);
    const scopes = projectScopes(db, projectId);
    expect(scopes.length).toBe(1 + PROJECT_SUBFOLDERS.length);
    const folderId = scopes[0]!.id;
    drive.seed(folderId, [
      [
        {
          id: 'file-1',
          name: 'brief.pdf',
          mimeType: 'application/pdf',
          url: 'https://drive.test/file-1',
          modifiedAt: stamp,
          size: 1024,
        },
      ],
    ]);

    const result = await callIntegrationTool(
      db,
      session(),
      'files_browse_project',
      { projectId, folderId },
      { drive },
    );
    expect(result.outcome).toBe('SUCCESS');
    const listing = result.data as { files: { id: string }[]; state: string };
    expect(listing.state).toBe('READY');
    expect(listing.files.map((f) => f.id)).toEqual(['file-1']);
  });

  it('names the consulted store and endpoint when Drive is not connected', async () => {
    const { projectId } = seedProject();
    const drive = new MockDriveProvider();
    drive.connected = false;

    const result = await callIntegrationTool(
      db,
      session(),
      'files_browse_project',
      { projectId },
      { drive, baseUrl: 'https://hcc.example.com' },
    );

    expect(result.outcome).toBe('SUCCESS');
    expect(result.data).toMatchObject({
      state: 'NOT_CONNECTED',
      connection: {
        storeId: expect.any(String),
        baseUrl: 'https://hcc.example.com',
      },
    });
  });

  it('refreshes Buffer accounts through the unavailable default', async () => {
    const result = await callIntegrationTool(db, session(), 'signal_refresh_buffer_accounts', {
      clientRequestId: 'buf-default',
    });
    expect(result.outcome).toBe('SUCCESS');
    expect((result.data as { reason?: string }).reason).toMatch(/BUFFER_API_KEY/i);
  });

  it('refreshes Buffer accounts with an injected mock provider', async () => {
    const now = new Date('2026-08-29T12:00:00.000Z');
    const bufferAccounts = new BufferAccountsService(db, new MockBufferReadProvider(), () => now);
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_refresh_buffer_accounts',
      { clientRequestId: 'buf-ok' },
      { bufferAccounts, now },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect((result.data as { reason?: string }).reason).toBeUndefined();
    expect((result.data as { channels: unknown[] }).channels.length).toBeGreaterThan(0);
  });

  it('refreshes analytics window with offered windows or reports the reason', async () => {
    const now = new Date('2026-08-29T12:00:00.000Z');
    const provider = new MockAnalyticsWindowProvider();
    provider.hold([]);
    const analyticsWindow = new AnalyticsWindowService(db, provider, () => now, ['30d']);
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_refresh_analytics_window',
      { clientRequestId: 'aw-ok', platform: 'instagram', timeframe: '30d' },
      { analyticsWindow, now },
    );
    expect(result.outcome).toBe('SUCCESS');
  });

  it('refuses Zod-invalid write arguments', async () => {
    const result = await callIntegrationTool(db, session(), 'workspace_merge_clients_commit', {
      clientRequestId: 'zod-bad',
      sourceId: 'not-a-uuid',
      destinationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      planHash: 'a'.repeat(64),
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
  });

  it('fails recheck_post_media when the post is missing', async () => {
    const media = new MockDriveMediaProvider();
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_recheck_post_media',
      {
        clientRequestId: 'recheck-missing',
        postId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        driveFileId: 'drive-file-1',
      },
      { driveMedia: media },
    );
    expect(result.outcome).toBe('FAILURE');
    expect(result.errorDetail?.code).toBe('COORDINATION_NOT_FOUND');
    expect(result.error).toMatch(/No Signal post/);
  });

  it('refuses resolve_drive_media for a bad link', async () => {
    const media = new MockDriveMediaProvider();
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_resolve_drive_media',
      { clientRequestId: 'bad-link', link: 'https://example.com/not-drive' },
      { driveMedia: media },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
    expect(result.error).toMatch(/Drive/i);
  });

  it('fails merge preview when the source client is missing', async () => {
    const { destinationId } = seedClients();
    const result = await callIntegrationTool(db, session(), 'workspace_merge_clients_preview', {
      sourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      destinationId,
    });
    expect(result.outcome).toBe('FAILURE');
    expect(result.errorDetail?.code).toBe('COORDINATION_NOT_FOUND');
    expect(result.error).toMatch(/Client not found/i);
  });

  it('uses Unavailable providers when inventory and drive deps are omitted', async () => {
    const result = await callIntegrationTool(db, session(), 'signal_refresh_provider_inventory', {
      clientRequestId: 'inv-default',
    });
    expect(result.outcome).toBe('SUCCESS');
    const data = result.data as { reason?: string; entries: unknown[] };
    expect(data.reason).toBeTruthy();
    expect(data.entries).toEqual([]);
  });

  it('accepts driveMedia as a factory function', async () => {
    const fileId = '1AbCdEfGhIjKlMnOpQrStUvWxYzFactory01';
    let built = 0;
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_resolve_drive_media',
      {
        clientRequestId: 'resolve-fn',
        link: `https://drive.google.com/file/d/${fileId}/view`,
      },
      {
        driveMedia: () => {
          built += 1;
          const media = new MockDriveMediaProvider();
          media.seed(fileId, { name: 'factory.png', mimeType: 'image/png', size: '2048' });
          return media;
        },
      },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect(built).toBe(1);
    expect((result.data as { driveFileId: string }).driveFileId).toBe(fileId);
  });

  it('accepts drive as a factory function on files browse', async () => {
    const { clientId, projectId } = seedProject();
    let built = 0;
    const drive = new MockDriveProvider();
    await provisionClient(db, clientId, drive);
    await provisionProject(db, projectId, drive);
    const folderId = projectScopes(db, projectId)[0]!.id;

    const result = await callIntegrationTool(
      db,
      session(),
      'files_browse_project',
      { projectId, folderId },
      {
        drive: () => {
          built += 1;
          return drive;
        },
      },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect(built).toBe(1);
  });

  it('replaces provider inventory on a successful refresh', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.hold([
      {
        providerPostId: 'new-1',
        state: 'SCHEDULED',
        scheduledInstant: '2026-08-30T13:00:00.000Z',
        captionExcerpt: 'Fresh generation',
        accountIds: [1],
      },
    ]);
    const inventory = new ProviderInventoryService(
      db,
      provider,
      () => new Date('2026-08-29T12:00:00.000Z'),
    );
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_refresh_provider_inventory',
      { clientRequestId: 'inv-ok' },
      { inventory },
    );
    expect(result.outcome).toBe('SUCCESS');
    const data = result.data as { entries: { providerPostId: string }[]; reason?: string };
    expect(data.reason).toBeUndefined();
    expect(data.entries.map((e) => e.providerPostId)).toEqual(['new-1']);
  });

  it('fails files_browse_project when the project is missing', async () => {
    const result = await callIntegrationTool(
      db,
      session(),
      'files_browse_project',
      { projectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      { drive: new MockDriveProvider() },
    );
    expect(result.outcome).toBe('FAILURE');
    expect(result.errorDetail?.code).toBe('COORDINATION_NOT_FOUND');
  });

  it('refuses merge into self as invalid arguments', async () => {
    const { sourceId } = seedClients();
    const result = await callIntegrationTool(db, session(), 'workspace_merge_clients_preview', {
      sourceId,
      destinationId: sourceId,
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
  });

  it('refuses recheck_post_media when the Drive file is not on the post', async () => {
    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'post-for-recheck',
      text: 'No drive media here',
      channels: ['ig'],
      status: 'DRAFT',
    });
    expect(created.outcome).toBe('SUCCESS');
    const postId = (created.data as { after: { id: string } }).after.id;
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_recheck_post_media',
      {
        clientRequestId: 'recheck-media-err',
        postId,
        driveFileId: 'not-on-this-post',
      },
      { driveMedia: new MockDriveMediaProvider() },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
    expect(result.error).toMatch(/not one of this post/i);
  });

  it('refuses recheck_variant_media when no Drive role is stored', async () => {
    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'post-for-variant',
      text: 'Variant recheck host',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const postId = (created.data as { after: { id: string } }).after.id;
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_recheck_variant_media',
      {
        clientRequestId: 'var-recheck',
        postId,
        platform: 'instagram',
        accountId: 501,
        role: 'COVER_IMAGE',
      },
      { driveMedia: new MockDriveMediaProvider() },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
    expect(result.error).toMatch(/No Drive cover image/i);
  });

  it('refuses Signal import commit when the preview has expired', async () => {
    const text = signalImportText('Expired preview caption');
    const fingerprint = crypto
      .createHash('sha256')
      .update(text.replace(/\r\n?/g, '\n'))
      .digest('hex');
    const result = await callIntegrationTool(
      db,
      session(),
      'import_signal_commit',
      { clientRequestId: 'sig-expired', text, fingerprint },
      { driveMedia: new MockDriveMediaProvider() },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.error).toMatch(/preview expired/i);
  });

  it('refuses analytics refresh with Zod-invalid args and uses default Unavailable window', async () => {
    const bad = await callIntegrationTool(db, session(), 'signal_refresh_analytics_window', {
      clientRequestId: 'aw-bad',
      platform: 'not-a-platform',
      timeframe: '30d',
    });
    expect(bad.outcome).toBe('REFUSED');
    expect(bad.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');

    const unavailable = await callIntegrationTool(
      db,
      session(),
      'signal_refresh_analytics_window',
      { clientRequestId: 'aw-default', platform: 'instagram', timeframe: '30d' },
    );
    expect(unavailable.outcome).toBe('SUCCESS');
    expect((unavailable.data as { reason?: string }).reason).toBeTruthy();
  });

  it('refuses write tools when clientRequestId is missing', async () => {
    const drive = new MockDriveProvider();
    drive.connected = false;
    const result = await callIntegrationTool(db, session(), 'drive_sync', null, { drive });
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
  });

  it('refuses Zod-invalid merge preview args on the read path', async () => {
    const result = await callIntegrationTool(db, session(), 'workspace_merge_clients_preview', {
      sourceId: 'bad',
      destinationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
  });

  it('commits a merge with a CUSTOM empty field value', async () => {
    const { sourceId, destinationId } = seedClients();
    const preview = await callIntegrationTool(db, session(), 'workspace_merge_clients_preview', {
      sourceId,
      destinationId,
      fields: { notes: { choice: 'CUSTOM', value: '   ' } },
    });
    expect(preview.outcome).toBe('SUCCESS');
    const planHash = (preview.data as { planHash: string }).planHash;
    const commit = await callIntegrationTool(db, session(), 'workspace_merge_clients_commit', {
      clientRequestId: 'merge-custom-empty',
      sourceId,
      destinationId,
      fields: { notes: { choice: 'CUSTOM', value: '   ' } },
      planHash,
    });
    expect(commit.outcome).toBe('SUCCESS');
    const row = db.prepare('SELECT notes FROM clients WHERE id=?').get(destinationId) as {
      notes: string | null;
    };
    expect(row.notes).toBeNull();
  });

  it('lists integration activity when args are omitted', async () => {
    const result = await callIntegrationTool(db, session(), 'integration_list_activity', undefined);
    expect(result.outcome).toBe('SUCCESS');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('maps a provider throw that is not an Error into FAILURE', async () => {
    const inventory = {
      read: () => ({ entries: [], snapshotAt: null as string | null }),
      refresh: async () => {
        throw 'provider blew up';
      },
    };
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_refresh_provider_inventory',
      { clientRequestId: 'non-error-throw' },
      { inventory: inventory as never },
    );
    expect(result.outcome).toBe('FAILURE');
    expect(result.error).toBe('Integration tool failed.');
    expect(result.errorDetail?.code).toBe('COORDINATION_TOOL_FAILED');
  });

  it('maps a plain Error from an integration write into FAILURE', async () => {
    const inventory = {
      read: () => ({ entries: [], snapshotAt: null as string | null }),
      refresh: async () => {
        throw new Error('transient inventory outage');
      },
    };
    const result = await callIntegrationTool(
      db,
      session(),
      'signal_refresh_provider_inventory',
      { clientRequestId: 'plain-error-throw' },
      { inventory: inventory as never },
    );
    expect(result.outcome).toBe('FAILURE');
    expect(result.error).toBe('transient inventory outage');
  });
});

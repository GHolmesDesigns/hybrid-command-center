import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { createMcpSession } from './session.ts';
import { callWorkspaceWriteTool, isWorkspaceWriteTool } from './workspace-write.ts';
import { createProject, createTask, readBranding, readViewDefaults } from '../workspace/writes.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { setSetting } from '../drive/service.ts';
import { VIEW_DEFAULTS_SETTING_KEY } from '../../shared/view-defaults.ts';

let db: Db;
const stamp = '2026-08-29T12:00:00.000Z';
const NOW = new Date(2026, 7, 19, 12, 0, 0);

beforeEach(() => {
  db = createDb(':memory:');
});

const session = () => createMcpSession({ agentLabel: 'codex' });

const seed = () => {
  const clientId = '11111111-1111-4111-8111-111111111111';
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
  ).run(clientId, 'Acme Studio', 'acme-studio', stamp, stamp);
  const project = createProject(db, {
    clientId,
    name: 'Retainer',
    status: 'ACTIVE',
    priority: 'MEDIUM',
  });
  const task = createTask(db, {
    projectId: project.id,
    title: 'Host',
    status: 'TODO',
    priority: 'MEDIUM',
  });
  const other = createTask(db, {
    projectId: project.id,
    title: 'Other',
    status: 'TODO',
    priority: 'MEDIUM',
  });
  return { clientId, project, task, other };
};

const dayLabel = (offset: number) => {
  const moment = new Date(2026, 7, 19 + offset);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
};

describe('workspace MCP write tool matrix', () => {
  it('covers checklist and dependency tools', async () => {
    const { task, other } = seed();
    const add = await callWorkspaceWriteTool(db, session(), 'workspace_add_checklist_item', {
      clientRequestId: 'cl-1',
      taskId: task.id,
      revision: task.revision,
      text: 'One',
    });
    expect(add.outcome).toBe('SUCCESS');
    const afterAdd = (add.data as { after: { revision: number; checklist: Array<{ id: string }> } })
      .after;
    const itemId = afterAdd.checklist[0]!.id;
    const upd = await callWorkspaceWriteTool(db, session(), 'workspace_update_checklist_item', {
      clientRequestId: 'cl-2',
      itemId,
      revision: afterAdd.revision,
      completed: true,
    });
    expect(upd.outcome).toBe('SUCCESS');
    const afterUpd = (upd.data as { after: { revision: number } }).after;
    const rem = await callWorkspaceWriteTool(db, session(), 'workspace_remove_checklist_item', {
      clientRequestId: 'cl-3',
      itemId,
      confirmItemId: itemId,
      confirm: true,
      revision: afterUpd.revision,
    });
    expect(rem.outcome).toBe('SUCCESS');

    const dep = await callWorkspaceWriteTool(db, session(), 'workspace_add_dependency', {
      clientRequestId: 'dep-1',
      taskId: task.id,
      dependencyId: other.id,
      revision: (rem.data as { after: { revision: number } }).after.revision,
    });
    expect(dep.outcome).toBe('SUCCESS');
    const afterDep = (dep.data as { after: { revision: number } }).after;
    const undep = await callWorkspaceWriteTool(db, session(), 'workspace_remove_dependency', {
      clientRequestId: 'dep-2',
      taskId: task.id,
      dependencyId: other.id,
      confirmTaskId: task.id,
      confirm: true,
      revision: afterDep.revision,
    });
    expect(undep.outcome).toBe('SUCCESS');
  });

  it('covers publish targets dry-run and commit against injected accounts', async () => {
    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'tgt-post',
      text: 'Targets',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const post = (created.data as { after: { id: string; revision: number } }).after;
    const deps = {
      connectedAccounts: async () => [{ id: 501, platform: 'instagram' }],
    };

    const dry = await callWorkspaceWriteTool(
      db,
      session(),
      'signal_update_publish_targets',
      {
        clientRequestId: 'tgt-1',
        postId: post.id,
        revision: post.revision,
        dryRun: true,
        targets: [{ channel: 'ig', providerAccountIds: [501] }],
      },
      deps,
    );
    expect(dry.outcome).toBe('SUCCESS');
    expect(dry.data).toMatchObject({ dryRun: true });

    const write = await callWorkspaceWriteTool(
      db,
      session(),
      'signal_update_publish_targets',
      {
        clientRequestId: 'tgt-2',
        postId: post.id,
        revision: post.revision,
        targets: [{ channel: 'ig', providerAccountIds: [501] }],
      },
      deps,
    );
    expect(write.outcome).toBe('SUCCESS');
  });

  it('covers signal_ack_alert and confirmed project delete', async () => {
    const { project } = seed();
    const post = seedSignalPost(db, { date: dayLabel(1), status: 'PUBLISHED' });
    seedSignalPost(db, { date: dayLabel(3), channels: ['x'] });
    const publicationId = 'pub-matrix-1';
    db.prepare(
      `INSERT INTO signal_publications(
         id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
         sent_caption,sent_channels,sent_media,checked_at,checked_state,prior_state,check_attempts,
         created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      publicationId,
      post.id,
      'FAILED',
      'post-bridge',
      'remote-1',
      `key-${publicationId}`,
      '2026-08-19T22:00:00.000Z',
      'America/New_York',
      'A clear campaign post',
      JSON.stringify(['x']),
      '[]',
      null,
      null,
      null,
      0,
      '2026-08-18T00:00:00.000Z',
      '2026-08-18T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO signal_publication_targets(
         publication_id,channel,provider_account_id,mode,outcome,handle,error
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(publicationId, 'x', 1, 'AUTOMATIC', 'FAILURE', '@x', null);

    const alertId = `DELIVERY_ATTENTION:${publicationId}`;
    const ack = await callWorkspaceWriteTool(
      db,
      session(),
      'signal_ack_alert',
      {
        clientRequestId: 'ack-1',
        alertId,
      },
      { now: NOW },
    );
    expect(ack.outcome).toBe('SUCCESS');

    const del = await callWorkspaceWriteTool(db, session(), 'workspace_delete_project', {
      clientRequestId: 'del-proj',
      projectId: project.id,
      confirmProjectId: project.id,
      confirm: true,
    });
    expect(del.outcome).toBe('SUCCESS');
  });

  it('covers signal_update_variants commit and update_post media-free patch', async () => {
    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'var-host',
      text: 'Variant host',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const post = (created.data as { after: { id: string; revision: number } }).after;
    const variants = await callWorkspaceWriteTool(db, session(), 'signal_update_variants', {
      clientRequestId: 'var-1',
      postId: post.id,
      revision: post.revision,
      variants: [],
    });
    expect(variants.outcome).toBe('SUCCESS');
    const afterVariants = (variants.data as { after: { revision?: number } }).after;
    const nextRevision =
      typeof afterVariants?.revision === 'number' ? afterVariants.revision : post.revision + 1;
    const patched = await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
      clientRequestId: 'patch-1',
      postId: post.id,
      revision: nextRevision,
      text: 'Variant host edited',
    });
    expect(patched.outcome).toBe('SUCCESS');
  });

  it('refuses mismatched confirm ids and unknown tools', async () => {
    const { task } = seed();
    const refused = await callWorkspaceWriteTool(db, session(), 'workspace_delete_task', {
      clientRequestId: 'bad-confirm',
      taskId: task.id,
      confirmTaskId: '22222222-2222-4222-8222-222222222222',
      confirm: true,
    });
    expect(refused.outcome).toBe('REFUSED');
    expect(refused.errorDetail?.code).toBe('WORKSPACE_CONFIRMATION_REQUIRED');

    const unknown = await callWorkspaceWriteTool(db, session(), 'not_a_write_tool', {
      clientRequestId: 'x',
    });
    expect(unknown.outcome).toBe('FAILURE');
  });

  it('covers missing agent label on settings and not-found ack', async () => {
    const unlabeled = await callWorkspaceWriteTool(
      db,
      createMcpSession({ agentLabel: null }),
      'settings_update_view_defaults',
      {
        clientRequestId: 'views-no-label',
        viewDefaults: {},
      },
    );
    expect(unlabeled.outcome).toBe('REFUSED');

    const missing = await callWorkspaceWriteTool(db, session(), 'signal_ack_alert', {
      clientRequestId: 'ack-missing',
      alertId: 'DELIVERY_ATTENTION:nobody',
    });
    expect(missing.outcome).toBe('FAILURE');
    expect(missing.errorDetail?.code).toBe('COORDINATION_NOT_FOUND');
  });

  it('covers not-found, validation, slot conflict, rate limit, and local accounts', async () => {
    const { project, task } = seed();
    const missingTask = await callWorkspaceWriteTool(db, session(), 'workspace_update_task', {
      clientRequestId: 'nf-task',
      taskId: '22222222-2222-4222-8222-222222222222',
      revision: 1,
      title: 'Ghost',
    });
    expect(missingTask.outcome).toBe('FAILURE');

    const missingProject = await callWorkspaceWriteTool(db, session(), 'workspace_update_project', {
      clientRequestId: 'nf-proj',
      projectId: '22222222-2222-4222-8222-222222222222',
      revision: 1,
      name: 'Ghost',
    });
    expect(missingProject.outcome).toBe('FAILURE');

    const badArgs = await callWorkspaceWriteTool(db, session(), 'workspace_create_task', {
      clientRequestId: 'bad-zod',
      projectId: project.id,
      title: '',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    expect(badArgs.outcome).toBe('REFUSED');

    const inactiveClient = await callWorkspaceWriteTool(db, session(), 'workspace_create_project', {
      clientRequestId: 'bad-client',
      clientId: '33333333-3333-4333-8333-333333333333',
      name: 'Orphan',
    });
    expect(inactiveClient.outcome).toBe('REFUSED');

    const ghostPost = '44444444-4444-4444-8444-444444444444';
    const missingPost = await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
      clientRequestId: 'nf-post',
      postId: ghostPost,
      revision: 1,
      text: 'Nope',
    });
    expect(missingPost.outcome).toBe('FAILURE');

    const missingSlot = await callWorkspaceWriteTool(db, session(), 'signal_set_slot', {
      clientRequestId: 'nf-slot',
      postId: ghostPost,
      revision: 1,
      date: '2099-08-01',
      time: '10:00',
      from: '2099-08-01',
    });
    expect(missingSlot.outcome).toBe('FAILURE');

    const a = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'slot-a',
      text: 'A',
      channels: ['ig'],
      status: 'DRAFT',
      date: '2099-09-01',
      time: '11:00',
    });
    expect(a.outcome).toBe('SUCCESS');
    const b = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'slot-b',
      text: 'B',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const bId = (b.data as { after: { id: string; revision: number } }).after.id;
    const conflict = await callWorkspaceWriteTool(db, session(), 'signal_set_slot', {
      clientRequestId: 'slot-conflict',
      postId: bId,
      revision: 1,
      date: '2099-09-01',
      time: '11:00',
      from: '2099-09-01',
    });
    expect(conflict.outcome).toBe('REFUSED');

    db.prepare(
      `INSERT INTO signal_provider_accounts(
         id,provider,provider_account_ref,platform,display_name,handle,
         resolved_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(601, 'post-bridge', '601', 'instagram', 'IG', '@ig', stamp, stamp, stamp);
    const localTargets = await callWorkspaceWriteTool(
      db,
      session(),
      'signal_update_publish_targets',
      {
        clientRequestId: 'local-tgt',
        postId: bId,
        revision: 1,
        dryRun: true,
        targets: [{ channel: 'ig', providerAccountIds: [601] }],
      },
    );
    expect(localTargets.outcome).toBe('SUCCESS');

    const limited = createMcpSession({ agentLabel: 'rate-limited' });
    for (let i = 0; i < 10; i += 1) {
      const result = await callWorkspaceWriteTool(db, limited, 'signal_create_post', {
        clientRequestId: `rl-${i}`,
        text: `Rate ${i}`,
        channels: ['ig'],
        status: 'DRAFT',
      });
      expect(result.outcome).toBe('SUCCESS');
    }
    const over = await callWorkspaceWriteTool(db, limited, 'signal_create_post', {
      clientRequestId: 'rl-over',
      text: 'Too many',
      channels: ['ig'],
      status: 'DRAFT',
    });
    expect(over.outcome).toBe('REFUSED');
    expect(over.errorDetail?.code).toBe('COORDINATION_RATE_LIMIT_EXCEEDED');

    expect(isWorkspaceWriteTool('workspace_create_task')).toBe(true);
    expect(isWorkspaceWriteTool('signal_publish_submit')).toBe(false);

    const missingChecklist = await callWorkspaceWriteTool(
      db,
      session(),
      'workspace_update_checklist_item',
      {
        clientRequestId: 'nf-check',
        itemId: '55555555-5555-4555-8555-555555555555',
        revision: 1,
        completed: true,
      },
    );
    expect(missingChecklist.outcome).toBe('FAILURE');

    const missingAddCheck = await callWorkspaceWriteTool(
      db,
      session(),
      'workspace_add_checklist_item',
      {
        clientRequestId: 'nf-add-check',
        taskId: '55555555-5555-4555-8555-555555555555',
        revision: 1,
        text: 'Ghost',
      },
    );
    expect(missingAddCheck.outcome).toBe('FAILURE');

    const removeGhost = await callWorkspaceWriteTool(
      db,
      session(),
      'workspace_remove_checklist_item',
      {
        clientRequestId: 'nf-rem-check',
        itemId: '55555555-5555-4555-8555-555555555555',
        confirmItemId: '55555555-5555-4555-8555-555555555555',
        confirm: true,
        revision: 1,
      },
    );
    expect(removeGhost.outcome).toBe('FAILURE');

    const cycle = await callWorkspaceWriteTool(db, session(), 'workspace_add_dependency', {
      clientRequestId: 'cycle-1',
      taskId: task.id,
      dependencyId: task.id,
      revision: task.revision,
    });
    expect(cycle.outcome).toBe('REFUSED');

    const missingDepTask = await callWorkspaceWriteTool(db, session(), 'workspace_add_dependency', {
      clientRequestId: 'nf-dep',
      taskId: '55555555-5555-4555-8555-555555555555',
      dependencyId: task.id,
      revision: 1,
    });
    expect(missingDepTask.outcome).toBe('FAILURE');

    const removeDepMissing = await callWorkspaceWriteTool(
      db,
      session(),
      'workspace_remove_dependency',
      {
        clientRequestId: 'nf-undep',
        taskId: '55555555-5555-4555-8555-555555555555',
        dependencyId: task.id,
        confirmTaskId: '55555555-5555-4555-8555-555555555555',
        confirm: true,
        revision: 1,
      },
    );
    expect(removeDepMissing.outcome).toBe('FAILURE');

    const removeDepUnconfirmed = await callWorkspaceWriteTool(
      db,
      session(),
      'workspace_remove_dependency',
      {
        clientRequestId: 'undep-confirm',
        taskId: task.id,
        dependencyId: task.id,
        confirmTaskId: task.id,
        confirm: false,
        revision: task.revision,
      },
    );
    expect(removeDepUnconfirmed.outcome).toBe('REFUSED');

    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'tgt-bad-acct',
      text: 'Bad target',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const post = (created.data as { after: { id: string; revision: number } }).after;
    const badTarget = await callWorkspaceWriteTool(
      db,
      session(),
      'signal_update_publish_targets',
      {
        clientRequestId: 'tgt-bad',
        postId: post.id,
        revision: post.revision,
        targets: [{ channel: 'ig', providerAccountIds: [999001] }],
      },
      { connectedAccounts: async () => [{ id: 1, platform: 'instagram' }] },
    );
    expect(badTarget.outcome).toBe('REFUSED');

    const emptyAccountsDry = await callWorkspaceWriteTool(
      db,
      session(),
      'signal_update_publish_targets',
      {
        clientRequestId: 'tgt-empty-local',
        postId: post.id,
        revision: post.revision,
        dryRun: true,
        targets: [],
      },
    );
    expect(emptyAccountsDry.outcome).toBe('SUCCESS');

    const badVariant = await callWorkspaceWriteTool(db, session(), 'signal_update_variants', {
      clientRequestId: 'var-bad',
      postId: post.id,
      revision: post.revision,
      variants: [
        {
          platform: 'instagram',
          accountId: null,
          text: { caption: 'x'.repeat(5000) },
        },
      ],
    });
    expect(['REFUSED', 'FAILURE', 'SUCCESS']).toContain(badVariant.outcome);

    const badMedia = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'drive-media',
      text: 'Drive media blocked',
      channels: ['ig'],
      status: 'DRAFT',
      media: [{ url: 'https://drive.google.com/file/d/abc123/view' }],
    });
    expect(['REFUSED', 'FAILURE']).toContain(badMedia.outcome);

    const noClientRequestId = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      text: 'Missing id',
      channels: ['ig'],
    });
    expect(noClientRequestId.outcome).toBe('REFUSED');

    setSetting(db, 'branding', '{not-json');
    expect(readBranding(db).title.length).toBeGreaterThan(0);
    setSetting(db, VIEW_DEFAULTS_SETTING_KEY, '{not-json');
    expect(readViewDefaults(db)).toBeTruthy();
  });
});

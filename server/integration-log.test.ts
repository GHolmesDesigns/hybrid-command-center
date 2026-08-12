import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.ts';
import { createDb, transaction, type Db } from './db.ts';
import {
  listIntegrationEvents,
  recordIntegrationEvent,
  redactSecrets,
  type IntegrationEventInput,
} from './integration-log.ts';
import {
  INTEGRATION_EVENT_ENTITY_LIMIT,
  INTEGRATION_EVENT_LIMIT,
  type IntegrationEntity,
} from '../shared/integration-log.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const sync = (overrides: Partial<IntegrationEventInput> = {}): IntegrationEventInput => ({
  source: 'signal-campaign',
  operation: 'calendar.sync',
  outcome: 'SUCCESS',
  summary: 'Read 12 scheduled posts.',
  ...overrides,
});

const rowCount = () =>
  (db.prepare('SELECT COUNT(*) n FROM integration_events').get() as { n: number }).n;

describe('integration activity log', () => {
  it('records the source, operation, outcome, entities, and time of one operation', () => {
    const entities: IntegrationEntity[] = [
      { type: 'client', id: 'c1', label: 'Acme Studio' },
      { type: 'project', id: 'p1', label: 'Spring Campaign' },
    ];
    const written = recordIntegrationEvent(
      db,
      sync({ entities, correlationId: 'receipt-1', summary: 'Created two records.' }),
    );

    expect(listIntegrationEvents(db)).toEqual([
      {
        id: written.id,
        source: 'signal-campaign',
        operation: 'calendar.sync',
        outcome: 'SUCCESS',
        summary: 'Created two records.',
        entities,
        entityCount: 2,
        correlationId: 'receipt-1',
        createdAt: written.createdAt,
      },
    ]);
  });

  it('records a partial operation with the error that explains what did not land', () => {
    recordIntegrationEvent(
      db,
      sync({
        outcome: 'PARTIAL',
        summary: 'Read 8 of 12 scheduled posts.',
        entities: [{ type: 'task', id: 't1', label: 'Week 1 blog post' }],
        error: 'The scheduler stopped answering after the eighth page.',
      }),
    );

    const [event] = listIntegrationEvents(db);
    expect(event.outcome).toBe('PARTIAL');
    expect(event.error).toBe('The scheduler stopped answering after the eighth page.');
    // What did land is named, which is the whole point of a partial record.
    expect(event.entities).toEqual([{ type: 'task', id: 't1', label: 'Week 1 blog post' }]);
  });

  it('narrows the log by source and by the record an event explains, newest first', () => {
    recordIntegrationEvent(db, sync({ summary: 'First sync.' }));
    recordIntegrationEvent(db, sync({ summary: 'Second sync.', correlationId: 'run-2' }));
    recordIntegrationEvent(
      db,
      sync({ source: 'campaign-playbook', operation: 'playbook.import', summary: 'An import.' }),
    );

    expect(listIntegrationEvents(db).map((event) => event.summary)).toEqual([
      'An import.',
      'Second sync.',
      'First sync.',
    ]);
    expect(
      listIntegrationEvents(db, { source: 'signal-campaign' }).map((event) => event.summary),
    ).toEqual(['Second sync.', 'First sync.']);
    expect(listIntegrationEvents(db, { correlationId: 'run-2' }).map((e) => e.summary)).toEqual([
      'Second sync.',
    ]);
    expect(listIntegrationEvents(db, { limit: 1 }).map((event) => event.summary)).toEqual([
      'An import.',
    ]);
  });

  it('keeps the newest rows and prunes the rest, so the table cannot grow without a bound', () => {
    for (let index = 0; index < INTEGRATION_EVENT_LIMIT + 12; index++)
      recordIntegrationEvent(db, sync({ summary: `Sync ${index}` }));

    expect(rowCount()).toBe(INTEGRATION_EVENT_LIMIT);
    expect(listIntegrationEvents(db)[0].summary).toBe(`Sync ${INTEGRATION_EVENT_LIMIT + 11}`);
    // The oldest are the ones that went.
    expect(listIntegrationEvents(db).some((event) => event.summary === 'Sync 0')).toBe(false);
  });

  it('caps the entity list of one row while keeping the count it actually affected', () => {
    const entities = Array.from({ length: INTEGRATION_EVENT_ENTITY_LIMIT + 40 }, (_, index) => ({
      type: 'task' as const,
      id: `t${index}`,
      label: `Task ${index}`,
    }));
    const written = recordIntegrationEvent(db, sync({ entities }));

    expect(written.entities).toHaveLength(INTEGRATION_EVENT_ENTITY_LIMIT);
    expect(written.entityCount).toBe(INTEGRATION_EVENT_ENTITY_LIMIT + 40);
    const [read] = listIntegrationEvents(db);
    expect(read.entities).toHaveLength(INTEGRATION_EVENT_ENTITY_LIMIT);
    expect(read.entityCount).toBe(INTEGRATION_EVENT_ENTITY_LIMIT + 40);
  });

  it('rolls back with the caller when it writes inside a transaction', () => {
    expect(() =>
      transaction(db, () => {
        recordIntegrationEvent(db, sync());
        throw new Error('the operation this event belonged to failed after it');
      }),
    ).toThrow(/failed after it/);

    expect(rowCount()).toBe(0);
  });

  it('survives an entity list that is not readable JSON', () => {
    const written = recordIntegrationEvent(db, sync());
    db.prepare('UPDATE integration_events SET entities = ? WHERE id = ?').run(
      '{not json',
      written.id,
    );

    const [event] = listIntegrationEvents(db);
    expect(event.entities).toEqual([]);
    expect(event.summary).toBe('Read 12 scheduled posts.');
  });

  describe('credentials', () => {
    it('never writes a token, key, or password that reached an error message', () => {
      recordIntegrationEvent(
        db,
        sync({
          outcome: 'FAILURE',
          error:
            'GET https://example.test/v1/posts?access_token=ya29.a0AfB_x9Qsecretvalue failed: ' +
            'Authorization: Bearer ya29.a0AfB_x9Qsecretvalue rejected, client_secret="GOCSPX-abc123", ' +
            'password: hunter2 — retry with refresh_token=1//04xyzREFRESHTOKENVALUE',
        }),
      );

      const [event] = listIntegrationEvents(db);
      const error = event.error ?? '';
      for (const secret of [
        'ya29.',
        'GOCSPX-abc123',
        'hunter2',
        '1//04xyzREFRESHTOKENVALUE',
        'secretvalue',
      ])
        expect(error).not.toContain(secret);
      // The message still says what failed and which credential it was about.
      expect(error).toContain('https://example.test/v1/posts');
      expect(error).toContain('[redacted]');
    });

    it('redacts a JWT and truncates a message too long to be a message', () => {
      const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(30)}`;
      expect(redactSecrets(`Refused: ${jwt}`)).toBe('Refused: [redacted]');

      const long = redactSecrets('x'.repeat(4000));
      expect(long.length).toBeLessThan(600);
      expect(long.endsWith('…')).toBe(true);
    });

    it('leaves an ordinary failure exactly as it reads', () => {
      const message = 'The scheduler answered 503 Service Unavailable. Try again in a minute.';
      expect(redactSecrets(message)).toBe(message);
    });
  });

  describe('the read endpoint', () => {
    it('answers with the log, newest first, and filters by source', async () => {
      recordIntegrationEvent(db, sync({ summary: 'A sync.' }));
      recordIntegrationEvent(
        db,
        sync({ source: 'campaign-playbook', operation: 'playbook.import', summary: 'An import.' }),
      );
      const app = createApp(db);

      const all = await request(app).get('/api/integrations/activity');
      expect(all.status).toBe(200);
      expect(all.body.map((event: { summary: string }) => event.summary)).toEqual([
        'An import.',
        'A sync.',
      ]);

      const filtered = await request(app).get(
        '/api/integrations/activity?source=campaign-playbook',
      );
      expect(filtered.body.map((event: { summary: string }) => event.summary)).toEqual([
        'An import.',
      ]);
    });

    it('refuses a source it does not know and a limit outside the bound', async () => {
      const app = createApp(db);
      expect((await request(app).get('/api/integrations/activity?source=whatever')).status).toBe(
        400,
      );
      expect((await request(app).get('/api/integrations/activity?limit=0')).status).toBe(400);
      expect(
        (await request(app).get(`/api/integrations/activity?limit=${INTEGRATION_EVENT_LIMIT + 1}`))
          .status,
      ).toBe(400);
    });

    it('is append-only from the browser: nothing writes, edits, or deletes a record', async () => {
      recordIntegrationEvent(db, sync());
      const [event] = listIntegrationEvents(db);
      const app = createApp(db);

      for (const attempt of [
        request(app).post('/api/integrations/activity').send(sync()),
        request(app).put('/api/integrations/activity').send(sync()),
        request(app).patch(`/api/integrations/activity/${event.id}`).send({ summary: 'edited' }),
        request(app).delete(`/api/integrations/activity/${event.id}`),
      ])
        expect((await attempt).status).toBe(404);

      expect(listIntegrationEvents(db)).toEqual([event]);
    });
  });
});

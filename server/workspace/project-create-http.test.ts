import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb } from '../db.ts';

describe('POST /api/projects after writer extraction', () => {
  it('creates a project from form-like bodies', async () => {
    const db = createDb(':memory:');
    const stamp = '2026-08-29T12:00:00.000Z';
    const clientId = '11111111-1111-4111-8111-111111111111';
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
    ).run(clientId, 'Acme', 'acme', stamp, stamp);
    const app = createApp(db);
    const res = await request(app).post('/api/projects').send({
      clientId,
      name: 'Launch Pad',
      description: '',
      status: 'ACTIVE',
      priority: 'MEDIUM',
      startDate: '',
      targetDeadline: '',
      notes: '',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Launch Pad', clientId });
  });
});

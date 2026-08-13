import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { Request, RequestHandler, Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  DRIVE_BUDGET,
  HEADERS_TIMEOUT_MS,
  IMPORT_BUDGET,
  REQUEST_TIMEOUT_MS,
  SAMPLE_PLAYBOOK_BUDGET,
  concurrencyGate,
  configureServerTimeouts,
  postsOnly,
  requestBudget,
} from './budgets.ts';

/**
 * The three things a budget touches on a response — a header, a status, a body — plus the events
 * the concurrency gate releases its slot on. Stubbed rather than driven over HTTP so a test can
 * vary the client address and finish a response by hand, neither of which supertest allows.
 * `app.test.ts` covers the wiring; this file covers the rules.
 */
class FakeResponse extends EventEmitter {
  statusCode: number | undefined;
  body: { error?: string } | undefined;
  headers: Record<string, string> = {};

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(payload: { error?: string }) {
    this.body = payload;
    return this;
  }
}

/** Runs one request through a handler and reports whether it was passed on or answered. */
function send(handler: RequestHandler, req: Partial<Request> = {}) {
  const res = new FakeResponse();
  let passed = false;
  handler({ ip: '10.0.0.1', method: 'POST', ...req } as Request, res as unknown as Response, () => {
    passed = true;
  });
  return { res, passed, finish: () => res.emit('finish'), abort: () => res.emit('close') };
}

/** A clock a test moves itself, so a five-minute window costs no wall time to expire. */
function fixedClock(start = '2026-01-01T00:00:00.000Z') {
  let at = new Date(start);
  return {
    now: () => at,
    advance: (ms: number) => {
      at = new Date(at.getTime() + ms);
    },
  };
}

describe('a request budget', () => {
  it('passes a full window through and refuses the request after it', () => {
    const clock = fixedClock();
    const budget = requestBudget(IMPORT_BUDGET, { now: clock.now });

    for (let i = 0; i < IMPORT_BUDGET.limit; i += 1) expect(send(budget).passed).toBe(true);

    const refused = send(budget);
    expect(refused.passed).toBe(false);
    expect(refused.res.statusCode).toBe(429);
    expect(refused.res.body).toEqual({ error: IMPORT_BUDGET.message });
  });

  it('tells a refused caller how long the window has left, never zero seconds', () => {
    const clock = fixedClock();
    const budget = requestBudget(DRIVE_BUDGET, { now: clock.now });
    for (let i = 0; i < DRIVE_BUDGET.limit; i += 1) send(budget);

    expect(send(budget).res.headers['retry-after']).toBe('60');
    // One millisecond of the window remains, which rounds up to a second rather than down to none.
    clock.advance(DRIVE_BUDGET.windowMs - 1);
    expect(send(budget).res.headers['retry-after']).toBe('1');
  });

  it('starts a fresh window once the old one has run out', () => {
    const clock = fixedClock();
    const budget = requestBudget(IMPORT_BUDGET, { now: clock.now });
    for (let i = 0; i < IMPORT_BUDGET.limit; i += 1) send(budget);
    expect(send(budget).passed).toBe(false);

    clock.advance(IMPORT_BUDGET.windowMs);
    expect(send(budget).passed).toBe(true);
  });

  it('counts each address against its own window', () => {
    const clock = fixedClock();
    const budget = requestBudget(IMPORT_BUDGET, { now: clock.now });
    for (let i = 0; i < IMPORT_BUDGET.limit; i += 1) send(budget, { ip: '10.0.0.1' });

    expect(send(budget, { ip: '10.0.0.1' }).passed).toBe(false);
    expect(send(budget, { ip: '10.0.0.2' }).passed).toBe(true);
  });

  it('meters the sample playbook download on a window of its own, reads included', () => {
    const clock = fixedClock();
    const importing = requestBudget(IMPORT_BUDGET, { now: clock.now, applies: postsOnly });
    const sample = requestBudget(SAMPLE_PLAYBOOK_BUDGET, { now: clock.now });

    // The download is a GET, so it has to be metered without `postsOnly` — the import budget
    // beside it would wave it through however many arrived.
    for (let i = 0; i < SAMPLE_PLAYBOOK_BUDGET.limit; i += 1)
      expect(send(sample, { method: 'GET' }).passed).toBe(true);
    const refused = send(sample, { method: 'GET' });
    expect(refused.passed).toBe(false);
    expect(refused.res.body).toEqual({ error: SAMPLE_PLAYBOOK_BUDGET.message });

    /**
     * Two windows, not one. The sample is what fixes the workbook that spent the import budget,
     * and an import is what a downloaded sample leads to; sharing a bucket would have each of
     * them withhold the other at the moment it is wanted.
     */
    expect(send(importing).passed).toBe(true);
  });

  it('leaves a request outside what it meters alone, however many arrive', () => {
    const clock = fixedClock();
    const budget = requestBudget(IMPORT_BUDGET, { now: clock.now, applies: postsOnly });

    for (let i = 0; i < IMPORT_BUDGET.limit * 5; i += 1)
      expect(send(budget, { method: 'GET' }).passed).toBe(true);
    // The reads never counted, so the whole window is still there for the writes.
    expect(send(budget, { method: 'POST' }).passed).toBe(true);
  });

  it('counts a request with no address against one shared window', () => {
    const clock = fixedClock();
    const budget = requestBudget(IMPORT_BUDGET, { now: clock.now });
    // Express leaves `req.ip` undefined once the socket is gone. Treating that as its own key per
    // request would hand every such caller a fresh window, which is the wrong way to be wrong.
    for (let i = 0; i < IMPORT_BUDGET.limit; i += 1) send(budget, { ip: undefined });

    expect(send(budget, { ip: undefined }).passed).toBe(false);
  });

  it('reads the real clock when no clock is supplied', () => {
    // The production mount passes one; this is the default the app would fall back to.
    const budget = requestBudget({ limit: 1, windowMs: 60_000, message: 'spent' });

    expect(send(budget).passed).toBe(true);
    expect(send(budget).res.body).toEqual({ error: 'spent' });
  });

  it('bounds what it tracks, dropping the oldest window rather than growing forever', () => {
    const clock = fixedClock();
    const budget = requestBudget(IMPORT_BUDGET, { now: clock.now });
    // Spend one address's window, then flood past the tracking cap inside the same window.
    for (let i = 0; i < IMPORT_BUDGET.limit; i += 1) send(budget, { ip: '10.0.0.1' });
    expect(send(budget, { ip: '10.0.0.1' }).passed).toBe(false);

    for (let i = 0; i < 1100; i += 1)
      send(budget, { ip: `10.9.${Math.floor(i / 256)}.${i % 256}` });

    /**
     * The spent window was the oldest, so it was evicted and that address is served again. That
     * is the trade the cap makes: bounded memory over perfect bookkeeping for an attacker who can
     * already forge a thousand source addresses. It costs nothing for the one operator this app
     * has, and a deployment where it would matter needs authentication first (C20 §5).
     */
    expect(send(budget, { ip: '10.0.0.1' }).passed).toBe(true);
  });
});

describe('the import concurrency gate', () => {
  it('refuses a second request while the first is still in flight', () => {
    const gate = concurrencyGate(1, 'busy');
    const first = send(gate);
    expect(first.passed).toBe(true);

    const second = send(gate);
    expect(second.passed).toBe(false);
    expect(second.res.statusCode).toBe(503);
    expect(second.res.body).toEqual({ error: 'busy' });
    expect(second.res.headers['retry-after']).toBe('1');
  });

  it('frees the slot when the response finishes', () => {
    const gate = concurrencyGate(1, 'busy');
    const first = send(gate);
    first.finish();
    expect(send(gate).passed).toBe(true);
  });

  it('frees the slot when the connection is dropped mid-request', () => {
    const gate = concurrencyGate(1, 'busy');
    send(gate).abort();
    expect(send(gate).passed).toBe(true);
  });

  it('frees a slot once, however many times the response reports itself done', () => {
    const gate = concurrencyGate(1, 'busy');
    const first = send(gate);
    // Express emits both on an ordinary response; a double release would hand out a slot that
    // was never taken and the cap would drift upward for the life of the process.
    first.finish();
    first.abort();

    const second = send(gate);
    expect(second.passed).toBe(true);
    expect(send(gate).passed).toBe(false);
  });

  it('does not meter a request outside what it applies to', () => {
    const gate = concurrencyGate(1, 'busy', { applies: postsOnly });
    send(gate, { method: 'GET' });
    send(gate, { method: 'GET' });
    expect(send(gate, { method: 'POST' }).passed).toBe(true);
  });
});

describe('server timeouts', () => {
  it('sets the header and request deadlines Express leaves to Node', async () => {
    const server = http.createServer();
    configureServerTimeouts(server);

    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    // A header deadline under `keepAliveTimeout` closes idle sockets that are behaving.
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.requestTimeout).toBeGreaterThan(server.headersTimeout);
    await new Promise((resolve) => server.close(resolve));
  });
});

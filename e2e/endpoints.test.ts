import { describe, expect, it } from 'vitest';
import { E2E_STOP_PATH, handleE2eStopRequest, isLoopbackAddress } from './endpoints.ts';

describe('E2E stop endpoint helper', () => {
  it('recognizes loopback addresses only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('handles a loopback POST by stopping', () => {
    const reasons: string[] = [];
    const res = { statusCode: 0, end: (callback?: () => void) => callback?.() };
    expect(
      handleE2eStopRequest(
        { method: 'POST', url: E2E_STOP_PATH, socket: { remoteAddress: '127.0.0.1' } },
        res,
        (reason) => reasons.push(reason),
      ),
    ).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(reasons).toEqual(['stop endpoint']);
  });

  it('rejects non-loopback callers without stopping', () => {
    const reasons: string[] = [];
    const res = { statusCode: 0, end: () => undefined };
    expect(
      handleE2eStopRequest(
        { method: 'POST', url: E2E_STOP_PATH, socket: { remoteAddress: '8.8.8.8' } },
        res,
        (reason) => reasons.push(reason),
      ),
    ).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(reasons).toEqual([]);
  });

  it('leaves unrelated requests to the rest of the stack', () => {
    const res = { statusCode: 0, end: () => undefined };
    expect(
      handleE2eStopRequest(
        { method: 'GET', url: '/api/health', socket: { remoteAddress: '127.0.0.1' } },
        res,
        () => undefined,
      ),
    ).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});

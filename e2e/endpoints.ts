export const E2E_API_PORT = 8788;
export const E2E_WEB_PORT = 5174;
export const E2E_STOP_PATH = '/__e2e/stop';

export const e2eApiOrigin = `http://127.0.0.1:${E2E_API_PORT}`;
export const e2eWebOrigin = `http://127.0.0.1:${E2E_WEB_PORT}`;

export function isLoopbackAddress(address: string | undefined | null) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

type StopRequest = { method?: string; url?: string; socket: { remoteAddress?: string } };
type StopResponse = { statusCode: number; end: (callback?: () => void) => void };

/**
 * Loopback-only cooperative stop. Returns true when the request was handled, so the
 * caller can skip the rest of the stack. Production `createApp` never installs this.
 */
export function handleE2eStopRequest(
  req: StopRequest,
  res: StopResponse,
  stop: (reason: string) => void,
) {
  if (req.method !== 'POST' || req.url?.split('?')[0] !== E2E_STOP_PATH) return false;
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.statusCode = 404;
    res.end();
    return true;
  }
  res.statusCode = 204;
  res.end(() => stop('stop endpoint'));
  return true;
}

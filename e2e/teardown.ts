import net from 'node:net';
import {
  E2E_API_PORT,
  E2E_STOP_PATH,
  E2E_WEB_PORT,
  e2eApiOrigin,
  e2eWebOrigin,
} from './endpoints.ts';

const PORT_FREE_TIMEOUT_MS = 5_000;

/**
 * Ask both E2E servers to exit before Playwright's webServer plugin tears them down.
 *
 * On Windows that plugin skips SIGTERM and `spawnSync`s `taskkill` while stdio is still
 * piped, which can deadlock the runner after a passing summary. If the children are
 * already gone, the kill is skipped and the command can return.
 */
export default async function globalTeardown() {
  await Promise.all([requestStop(e2eApiOrigin), requestStop(e2eWebOrigin)]);
  await Promise.all([waitUntilPortFree(E2E_API_PORT), waitUntilPortFree(E2E_WEB_PORT)]);
}

async function requestStop(origin: string) {
  try {
    await fetch(`${origin}${E2E_STOP_PATH}`, { method: 'POST' });
  } catch (error) {
    if (isUnavailable(error)) return;
    throw error;
  }
}

function isUnavailable(error: unknown) {
  const code =
    error && typeof error === 'object' && 'cause' in error
      ? (error.cause as { code?: string } | undefined)?.code
      : (error as { code?: string }).code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET';
}

function isListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitUntilPortFree(port: number) {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isListening(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`E2E port ${port} was still in use after ${PORT_FREE_TIMEOUT_MS}ms`);
}

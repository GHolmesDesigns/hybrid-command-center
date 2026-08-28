import type { Request, RequestHandler } from 'express';
import type { Server } from 'node:http';

/**
 * Request budgets for an API that has no authentication.
 *
 * Every route trusts whichever browser can reach it, which is acceptable on `127.0.0.1` and
 * nowhere else (`docs/cloud-hosting.md` §5). C20 (#77) recommends a private remote instance, so
 * the routes that cost real memory, CPU, or a third party's quota get a ceiling here rather than
 * inheriting one at the moment a listen address leaves loopback.
 *
 * Deliberately **not** one global limiter. The board is used interactively — a drag reorders
 * several tasks, opening a project reads its tasks and its files — and a single bucket over every
 * route would throttle ordinary browsing long before it inconvenienced a loop. What is budgeted
 * is import and Drive; everything else stays unmetered.
 *
 * Windows are counted per client address. Behind a reverse proxy every request carries the
 * proxy's address unless Express is told to trust it, which collapses the budgets into one shared
 * bucket. That is the correct reading for the single-operator deployment C20 describes; a
 * multi-user shape would have to set `trust proxy` and revisit the keying.
 */

/** A fixed window: `limit` requests per `windowMs` from one address, refused with `message`. */
export type Budget = {
  limit: number;
  windowMs: number;
  /** What a refused caller is told. Each mount names itself, so a 429 says which budget it hit. */
  message: string;
};

/**
 * Import is the tightest budget in the app, because it is the one route that reads a body of
 * megabytes and then does real work per request: `previewPlaybook` parses a workbook and plans
 * it against the whole workspace before anything is written.
 *
 * Twelve in five minutes is far above use — a human previews, fixes a row, previews again, and
 * commits — and far below what a loop needs to be interesting.
 */
export const IMPORT_BUDGET: Budget = {
  limit: 12,
  windowMs: 5 * 60_000,
  message: 'Too many import requests. Wait a few minutes and try again.',
};

/**
 * The sample playbook download sends the same 86 KB file off disk on every request, so what it
 * costs is bytes and a file read rather than the parse and plan `IMPORT_BUDGET` meters. It gets
 * its own window rather than sharing that one: a spent import budget must not take away the file
 * a first-time importer is downloading in order to fix the workbook that spent it.
 *
 * Thirty a minute is far above use — the link is pressed once, twice if the first download was
 * lost — and it caps a loop at a couple of megabytes a minute.
 */
export const SAMPLE_PLAYBOOK_BUDGET: Budget = {
  limit: 30,
  windowMs: 60_000,
  message: 'Too many sample playbook downloads. Wait a moment and try again.',
};

/**
 * Drive routes spend someone else's quota and wait on a network round trip. Two a second
 * sustained covers clicking through folders as fast as a person can — the Files page reads one
 * listing per folder — while capping a loop at a rate Google's own quota will not notice.
 */
export const DRIVE_BUDGET: Budget = {
  limit: 120,
  windowMs: 60_000,
  message: 'Too many Drive requests. Wait a moment and try again.',
};

/**
 * A sync is not one Drive call. `syncAllToDrive` walks every client and project and provisions
 * what is missing, so it costs a multiple of the other Drive routes and is never something a
 * person presses repeatedly. It gets its own, much tighter window on top of `DRIVE_BUDGET`.
 */
export const DRIVE_SYNC_BUDGET: Budget = {
  limit: 4,
  windowMs: 60_000,
  message: 'A sync is already recent. Wait a minute before syncing again.',
};

/**
 * Login attempts across one address. Progressive delay in `server/auth/login-rate-limit.ts`
 * still gates wrong passwords; this ceiling is the Express-visible budget CodeQL and operators
 * read (via `express-rate-limit` in `app.ts`), and it also caps successful logins so a stolen
 * password cannot mint sessions unboundedly.
 */
export const AUTH_LOGIN_BUDGET: Budget = {
  limit: 30,
  windowMs: 15 * 60_000,
  message: 'Too many login attempts. Wait a few minutes and try again.',
};

/**
 * Status / logout / password-change under `/api/auth`. Separate from login so a spent login
 * window does not block logout or the status poll the AuthGate needs after sign-in.
 *
 * Six hundred a minute is far above a person (AuthGate asks once per load) and leaves headroom
 * for the e2e suite, which shares one address and remounts AuthGate on every navigation — React
 * Strict Mode doubles the status call, and a tight window was starving later specs with 429s.
 */
export const AUTH_ROUTE_BUDGET: Budget = {
  limit: 600,
  windowMs: 60_000,
  message: 'Too many authentication requests. Wait a moment and try again.',
};

/**
 * Drive OAuth start/callback. Uses `express-rate-limit` in `app.ts` (like auth) so CodeQL's
 * missing-rate-limiting query can see the limiter. Twenty in fifteen minutes is above a person
 * reconnecting after a failed consent screen and far below a connect-loop hammering Google.
 */
export const DRIVE_OAUTH_BUDGET: Budget = {
  limit: 20,
  windowMs: 15 * 60_000,
  message: 'Too many Drive connection attempts. Wait a few minutes and try again.',
};

/**
 * Operator MCP health panel under `/api/mcp/health`. Uses `express-rate-limit` in `app.ts` (like
 * auth) so CodeQL's missing-rate-limiting query can see the limiter. Sixty a minute is above a
 * person opening Settings and pressing Test connection a few times.
 */
export const MCP_HEALTH_BUDGET: Budget = {
  limit: 60,
  windowMs: 60_000,
  message: 'Too many MCP health requests. Wait a moment and try again.',
};

/**
 * How many import requests may be in flight at once. One, because the point of the cap is that a
 * caller cannot hold several multi-megabyte bodies in memory simultaneously — and it only holds
 * if the gate runs *before* the body parser, which is where `app.ts` mounts it.
 *
 * An import is a single-operator action with a modal in front of it, so serializing costs nothing
 * a user can perceive.
 */
export const IMPORT_CONCURRENCY = 1;
export const IMPORT_BUSY_MESSAGE = 'An import is already running. Wait for it to finish.';

/**
 * How many addresses a budget tracks. A single operator needs one; the cap exists so that a
 * flood of spoofed addresses cannot grow the map without bound. When it is reached, the windows
 * that started earliest are dropped first — they are the closest to expiring anyway.
 */
const MAX_TRACKED_CLIENTS = 1024;

/** Express leaves `req.ip` undefined when the socket is gone; one bucket is the safe reading. */
const clientKey = (req: Request) => req.ip ?? 'unknown';

type BudgetOptions = {
  /** The clock the window is measured against, so a test can expire one without waiting. */
  now?: () => Date;
  /** Which requests the budget counts. Defaults to all of them. */
  applies?: (req: Request) => boolean;
};

type Window = { count: number; startedAt: number };

function prune(windows: Map<string, Window>, at: number, windowMs: number) {
  for (const [key, window] of windows) if (at - window.startedAt >= windowMs) windows.delete(key);
  if (windows.size < MAX_TRACKED_CLIENTS) return;
  const oldestFirst = [...windows.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
  for (const [key] of oldestFirst.slice(0, windows.size - MAX_TRACKED_CLIENTS + 1))
    windows.delete(key);
}

/** Counts requests per address in a fixed window and answers 429 once the window is spent. */
export function requestBudget(budget: Budget, options: BudgetOptions = {}): RequestHandler {
  const now = options.now ?? (() => new Date());
  const applies = options.applies ?? (() => true);
  const windows = new Map<string, Window>();
  return (req, res, next) => {
    if (!applies(req)) return next();
    const at = now().getTime();
    prune(windows, at, budget.windowMs);
    const current = windows.get(clientKey(req));
    if (!current) {
      windows.set(clientKey(req), { count: 1, startedAt: at });
      return next();
    }
    if (current.count < budget.limit) {
      current.count += 1;
      return next();
    }
    /**
     * Seconds, rounded up and never zero: `Retry-After: 0` reads as "immediately", which is the
     * one thing this response does not mean.
     */
    const retryAfter = Math.max(1, Math.ceil((current.startedAt + budget.windowMs - at) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: budget.message });
  };
}

/**
 * Refuses a request while `limit` others are already in flight. Mounted ahead of the body parser
 * so a refused caller never gets its body read, which is the whole point: the memory a cap is
 * protecting is allocated by the parser, not by the route.
 */
export function concurrencyGate(
  limit: number,
  message: string,
  options: Pick<BudgetOptions, 'applies'> = {},
): RequestHandler {
  const applies = options.applies ?? (() => true);
  let active = 0;
  return (req, res, next) => {
    if (!applies(req)) return next();
    if (active >= limit) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: message });
      return;
    }
    active += 1;
    /**
     * `finish` and `close` both fire on a normal response and only `close` fires on an aborted
     * one, so both are listened for and the release is made idempotent. Leaking a slot here
     * would wedge import for the life of the process.
     */
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

/** Only the expensive half of a mounted prefix — a read under it is not what these budgets meter. */
export const postsOnly = (req: Request) => req.method === 'POST';

/**
 * How long a client may take to send its headers. Above `keepAliveTimeout`, which defaults to 5
 * seconds, because a header timeout below it closes idle keep-alive sockets that are behaving.
 */
export const HEADERS_TIMEOUT_MS = 10_000;
/**
 * How long a client may take to send an entire request. This measures receiving, not handling, so
 * a slow commit is not at risk — a caller trickling a 12 MB import body to hold the connection
 * open is, which is what it is for.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Node's defaults here are minutes long and Express sets neither, so a handful of connections
 * sending headers slowly can hold sockets with no request to show for them. Applied at the
 * server rather than as middleware, because no middleware runs until the headers arrive.
 */
export function configureServerTimeouts(server: Server) {
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

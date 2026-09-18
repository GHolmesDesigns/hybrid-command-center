/**
 * Agent Hub WebSocket live channel (C236 / #669).
 *
 * Authenticated upgrade on the app origin; wake frames name feeds only. Express session middleware
 * does not run on upgrade — the handler validates the session cookie explicitly.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Db } from '../db.ts';
import { readSessionToken } from '../auth/cookies.ts';
import { sessionFromRawToken } from '../auth/service.ts';
import type { OperatorSessionRecord } from '../auth/sessions.ts';
import type { AgentHubTipRegistry } from './tips.ts';
import {
  AGENT_HUB_WS_MAX_INBOUND_BYTES,
  AGENT_HUB_WS_MAX_INBOUND_MESSAGES_PER_SECOND,
  AGENT_HUB_WS_PATH,
  AGENT_HUB_WS_SERVER_PING_INTERVAL_MS,
  agentHubWakeFromTip,
  parseAgentHubClientFrame,
  type AgentHubAssistantDeltaFrame,
  type AgentHubAssistantTurnStateFrame,
  type AgentHubClientFrame,
  type AgentHubTypingFrame,
} from '../../shared/agent-hub-live.ts';
import { AgentHubTypingRegistry, registerAgentHubTypingRegistry } from './typing.ts';

export type AgentHubWsAuth = {
  authRequired: boolean;
  sessionSecret: string;
};

export type AgentHubWsOptions = {
  db: Db;
  appOrigin: string;
  auth: AgentHubWsAuth;
  now?: () => number;
};

type TrackedSocket = {
  ws: WebSocket;
  tokenHash: string | null;
  subscribedConversationIds: Set<string>;
  messageWindowStart: number;
  messageCount: number;
};

const POLICY_CLOSE = 1008;
const GOING_AWAY_CLOSE = 1001;

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`${statusLine}\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function requestOrigin(req: IncomingMessage): string | null {
  const raw = req.headers.origin;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
  return null;
}

function sessionForUpgrade(
  db: Db,
  req: IncomingMessage,
  auth: AgentHubWsAuth,
  now: number,
): OperatorSessionRecord | null {
  const rawToken = readSessionToken(req.headers.cookie);
  if (!auth.authRequired) return null;
  return sessionFromRawToken(db, {
    rawToken,
    sessionSecret: auth.sessionSecret,
    now,
  });
}

export class AgentHubLiveHub {
  private readonly registry: AgentHubTipRegistry;
  private readonly options: AgentHubWsOptions;
  private readonly typingRegistry: AgentHubTypingRegistry;
  private readonly sockets = new Set<TrackedSocket>();
  private wakeSeq = 0;
  private tipUnsubscribe: (() => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    registry: AgentHubTipRegistry,
    options: AgentHubWsOptions,
    typingRegistry: AgentHubTypingRegistry,
  ) {
    this.registry = registry;
    this.options = options;
    this.typingRegistry = typingRegistry;
    typingRegistry.attachBroadcast((conversationId, frame) => {
      this.broadcastTyping(conversationId, frame);
    });
  }

  attach(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });

    this.tipUnsubscribe = this.registry.subscribe((tip) => {
      this.wakeSeq += 1;
      const frame = agentHubWakeFromTip(this.wakeSeq, tip);
      const payload = JSON.stringify(frame);
      for (const tracked of this.sockets) {
        if (tracked.ws.readyState === tracked.ws.OPEN) tracked.ws.send(payload);
      }
    });

    this.pingTimer = setInterval(() => {
      for (const tracked of this.sockets) {
        if (tracked.ws.readyState === tracked.ws.OPEN) {
          tracked.ws.ping();
        }
      }
    }, AGENT_HUB_WS_SERVER_PING_INTERVAL_MS);
    this.pingTimer.unref();

    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== AGENT_HUB_WS_PATH) return;

      const origin = requestOrigin(req);
      if (origin !== this.options.appOrigin) {
        rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden');
        return;
      }

      const now = (this.options.now ?? (() => Date.now()))();
      const session = sessionForUpgrade(this.options.db, req, this.options.auth, now);
      if (this.options.auth.authRequired && !session) {
        rejectUpgrade(socket, 'HTTP/1.1 401 Unauthorized');
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, session);
      });
    });

    wss.on(
      'connection',
      (ws: WebSocket, _req: IncomingMessage, session: OperatorSessionRecord | null) => {
        const tracked: TrackedSocket = {
          ws,
          tokenHash: session?.tokenHash ?? null,
          subscribedConversationIds: new Set(),
          messageWindowStart: 0,
          messageCount: 0,
        };
        this.sockets.add(tracked);

        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            ws.close(POLICY_CLOSE, 'Binary frames are not accepted.');
            return;
          }
          const text = typeof data === 'string' ? data : data.toString('utf8');
          if (Buffer.byteLength(text, 'utf8') > AGENT_HUB_WS_MAX_INBOUND_BYTES) {
            ws.close(POLICY_CLOSE, 'Inbound frame too large.');
            return;
          }

          const nowMs = (this.options.now ?? (() => Date.now()))();
          if (nowMs - tracked.messageWindowStart >= 1_000) {
            tracked.messageWindowStart = nowMs;
            tracked.messageCount = 0;
          }
          tracked.messageCount += 1;
          if (tracked.messageCount > AGENT_HUB_WS_MAX_INBOUND_MESSAGES_PER_SECOND) {
            ws.close(POLICY_CLOSE, 'Inbound message rate exceeded.');
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            ws.close(POLICY_CLOSE, 'Invalid JSON frame.');
            return;
          }

          const frame = parseAgentHubClientFrame(parsed);
          if (!frame) {
            ws.close(POLICY_CLOSE, 'Unknown client frame kind.');
            return;
          }
          this.handleClientFrame(tracked, frame);
        });

        ws.on('close', () => {
          this.sockets.delete(tracked);
        });
      },
    );
  }

  private handleClientFrame(tracked: TrackedSocket, frame: AgentHubClientFrame): void {
    if (frame.kind === 'ping') {
      if (tracked.ws.readyState === tracked.ws.OPEN) {
        tracked.ws.send(JSON.stringify({ kind: 'pong' }));
      }
      return;
    }
    if (frame.kind === 'subscribe') {
      tracked.subscribedConversationIds.add(frame.conversationId);
      return;
    }
    tracked.subscribedConversationIds.delete(frame.conversationId);
  }

  closeForSession(tokenHash: string): void {
    for (const tracked of this.sockets) {
      if (tracked.tokenHash === tokenHash && tracked.ws.readyState === tracked.ws.OPEN) {
        tracked.ws.close(GOING_AWAY_CLOSE, 'Session ended.');
      }
    }
  }

  closeAll(): void {
    for (const tracked of this.sockets) {
      if (tracked.ws.readyState === tracked.ws.OPEN) {
        tracked.ws.close(GOING_AWAY_CLOSE, 'Server shutting down.');
      }
    }
    this.sockets.clear();
  }

  dispose(): void {
    this.closeAll();
    this.tipUnsubscribe?.();
    this.tipUnsubscribe = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.typingRegistry.dispose();
  }

  /** Test helper — count of open sockets. */
  openSocketCount(): number {
    return this.sockets.size;
  }

  sendAssistantDelta(
    tokenHash: string,
    conversationId: string,
    frame: AgentHubAssistantDeltaFrame,
  ): void {
    this.sendAssistantFrame(tokenHash, conversationId, frame);
  }

  sendAssistantTurnState(
    tokenHash: string,
    conversationId: string,
    frame: AgentHubAssistantTurnStateFrame,
  ): void {
    this.sendAssistantFrame(tokenHash, conversationId, frame);
  }

  private sendAssistantFrame(
    tokenHash: string,
    conversationId: string,
    frame: AgentHubAssistantDeltaFrame | AgentHubAssistantTurnStateFrame,
  ): void {
    const payload = JSON.stringify(frame);
    for (const tracked of this.sockets) {
      if ((tracked.tokenHash ?? '') !== (tokenHash ?? '')) continue;
      if (!tracked.subscribedConversationIds.has(conversationId)) continue;
      if (tracked.ws.readyState === tracked.ws.OPEN) tracked.ws.send(payload);
    }
  }

  /** Typing is routed to every socket subscribed to the conversation (LC-P5 / #675). */
  broadcastTyping(conversationId: string, frame: AgentHubTypingFrame): void {
    const payload = JSON.stringify(frame);
    for (const tracked of this.sockets) {
      if (!tracked.subscribedConversationIds.has(conversationId)) continue;
      if (tracked.ws.readyState === tracked.ws.OPEN) tracked.ws.send(payload);
    }
  }
}

let registeredHub: AgentHubLiveHub | null = null;

export function registerAgentHubLiveHub(hub: AgentHubLiveHub | null): void {
  registeredHub = hub;
}

export function closeAgentHubLiveForSession(tokenHash: string): void {
  registeredHub?.closeForSession(tokenHash);
}

export function sendAssistantDelta(
  tokenHash: string,
  conversationId: string,
  frame: AgentHubAssistantDeltaFrame,
): void {
  registeredHub?.sendAssistantDelta(tokenHash, conversationId, frame);
}

export function sendAssistantTurnState(
  tokenHash: string,
  conversationId: string,
  frame: AgentHubAssistantTurnStateFrame,
): void {
  registeredHub?.sendAssistantTurnState(tokenHash, conversationId, frame);
}

export function attachAgentHubWebSocket(
  server: HttpServer,
  registry: AgentHubTipRegistry,
  options: AgentHubWsOptions,
  typingRegistry = new AgentHubTypingRegistry({ now: options.now }),
): AgentHubLiveHub {
  const hub = new AgentHubLiveHub(registry, options, typingRegistry);
  hub.attach(server);
  registerAgentHubLiveHub(hub);
  registerAgentHubTypingRegistry(typingRegistry);
  return hub;
}

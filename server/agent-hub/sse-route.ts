/**
 * Shell SSE tip channel for Agent Hub (C219 / #605).
 *
 * Tips name affected feeds only. Clients subscribe when live tips are enabled in Settings and
 * reread HTTP state after each event — the same discipline as MCP change feeds.
 */
import type { Request, Response } from 'express';
import type { AgentHubTipRegistry } from './tips.ts';
import type { AgentHubTipPayload } from '../../shared/agent-hub-sse.ts';

function acceptIncludes(req: Request, value: string): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== 'string') return false;
  return accept.split(',').some((part) => part.trim().startsWith(value));
}

function writeSse(res: Response, payload: AgentHubTipPayload): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function handleAgentHubTipsGet(
  req: Request,
  res: Response,
  registry: AgentHubTipRegistry,
): void {
  if (!acceptIncludes(req, 'text/event-stream')) {
    res.status(406).json({ error: 'Accept text/event-stream to subscribe to Agent Hub tips.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as Response & { flushHeaders: () => void }).flushHeaders();
  }

  const onTip = (tip: AgentHubTipPayload) => {
    if (!res.writableEnded) writeSse(res, tip);
  };

  const unsubscribe = registry.subscribe(onTip);
  res.write(': connected\n\n');

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 15_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
}

/**
 * Process-local MCP resource update fan-out (C133).
 *
 * Change-feed writers call `notifyMcpResourceUpdated`. The HTTP app installs one bridge that
 * forwards tips into `McpHttpSessionRegistry` (replaced on each `createApp`, so tests do not
 * stack listeners). Agents that ignore every notification still converge via C132 cursors.
 */
type ResourceUpdateListener = (uri: string) => void;

/** Single app-owned bridge — last `setMcpResourceUpdateBridge` wins. */
let bridge: ResourceUpdateListener | null = null;

const listeners = new Set<ResourceUpdateListener>();

export function setMcpResourceUpdateBridge(listener: ResourceUpdateListener | null): void {
  bridge = listener;
}

/** Extra listeners (conformance / unit tests). Prefer the bridge for production wiring. */
export function onMcpResourceUpdated(listener: ResourceUpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyMcpResourceUpdated(uri: string): void {
  const normalized = uri.trim();
  if (!normalized) return;
  if (bridge) {
    try {
      bridge(normalized);
    } catch {
      // A broken bridge must not block the write that triggered the tip.
    }
  }
  for (const listener of listeners) {
    try {
      listener(normalized);
    } catch {
      // A broken listener must not block other sessions.
    }
  }
}

/** Test helper — clears bridge and listeners between suites. */
export function resetMcpResourceNotifierForTests(): void {
  bridge = null;
  listeners.clear();
}

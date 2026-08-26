/**
 * Rolling-window rate limiter for MCP session budgets (C111 coordination writes).
 *
 * In-memory only: one limiter per MCP process/session. Exceeding the budget is a soft refuse —
 * no SQLite write for the tool action — and the caller logs `REFUSED` to `mcp_agent_events`.
 */
export class RollingWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly stamps: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** True when a slot was taken; false when the window is already full. */
  tryConsume(nowMs: number = Date.now()): boolean {
    this.prune(nowMs);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(nowMs);
    return true;
  }

  /** How many writes remain in the current window (for diagnostics). */
  remaining(nowMs: number = Date.now()): number {
    this.prune(nowMs);
    return Math.max(0, this.limit - this.stamps.length);
  }

  private prune(nowMs: number): void {
    const floor = nowMs - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! < floor) this.stamps.shift();
  }
}

import type { SignalPost } from '../../shared/signal.ts';

/**
 * The one way anything outside Signal reads its schedule.
 *
 * Read-only by construction. There is exactly one method and it lists; there is deliberately no
 * counterpart that creates, moves, reschedules, or deletes a post, so a later mistake in the
 * calendar cannot reach a write through this interface. Signal's own writes live in
 * `service.ts`, which the calendar has no reason to import — the same split `browse.ts` and
 * `service.ts` keep for Drive (`AGENTS.md` §Structure).
 *
 * This exists as an interface rather than a direct call for two reasons. Tests get a mock
 * without a database, and if Signal is ever extracted into its own process the calendar changes
 * nothing: only the implementation behind this shape moves.
 */
export interface SignalProvider {
  /**
   * Whether the schedule can be read at all. False leaves the caller a real state to render
   * rather than an exception to swallow — the calendar degrades to task due dates alone.
   */
  readonly available: boolean;
  /**
   * Every dated post between `from` and `to`, both inclusive, both `YYYY-MM-DD` in local time.
   *
   * Unscheduled posts are never returned: they have no date, so they belong to no range and no
   * calendar cell. The planner is where they are seen.
   */
  listPosts(input: { from: string; to: string }): Promise<SignalPostRange>;
}

export interface SignalPostRange {
  from: string;
  to: string;
  /** Ordered by date, then time, then creation — a stable order for equal timestamps. */
  posts: SignalPost[];
  /**
   * True when the range held more posts than `SIGNAL_RANGE_LIMIT` allowed back. The caller shows
   * that rather than quietly presenting a partial month as a whole one.
   */
  truncated: boolean;
}

/**
 * The provider when Signal cannot answer. Every method fails the same way, so a caller that
 * forgets to check `available` still gets a named error instead of an empty schedule that looks
 * like a genuinely empty month.
 */
export class UnavailableSignalProvider implements SignalProvider {
  readonly available = false;
  private readonly reason: string;
  // Declared and assigned rather than a constructor parameter property: the server runs under
  // `node --experimental-strip-types`, which erases types without rewriting code, and a
  // parameter property needs the rewrite. It is a boot-time failure, not a type error.
  constructor(reason = 'Signal Campaign is unavailable.') {
    this.reason = reason;
  }
  async listPosts(): Promise<SignalPostRange> {
    throw new Error(this.reason);
  }
}

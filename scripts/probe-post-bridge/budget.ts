/**
 * The hard ceiling on live requests, and the part of it teardown cannot be starved of.
 *
 * Fifty is the number the plan fixed and it counts everything — the questions, the cleanup, and
 * the inventory that proves the cleanup worked. Raising it is a plan revision, not an argument.
 */
export const PROBE_REQUEST_BUDGET = 50;

/**
 * Requests only teardown may spend.
 *
 * Without a reserve the ceiling is a trap: a run that spends its last request asking a question
 * then cannot delete the posts it created, and "leave nothing behind" becomes untrue at exactly
 * the moment it matters. Twelve covers deleting every post and asset this probe can create plus a
 * complete paged inventory to prove they are gone, so the questions get the other thirty-eight.
 */
export const PROBE_TEARDOWN_RESERVE = 12;

/** Thrown *before* the call that would have exceeded the budget, never after it. */
export class ProbeBudgetExhaustedError extends Error {
  readonly label: string;
  readonly used: number;
  readonly ceiling: number;
  constructor(label: string, used: number, ceiling: number) {
    super(
      `Request budget exhausted before "${label}": ${used} of ${ceiling} allowed requests already spent.`,
    );
    this.name = 'ProbeBudgetExhaustedError';
    this.label = label;
    this.used = used;
    this.ceiling = ceiling;
  }
}

/**
 * A counter that refuses rather than a counter that reports.
 *
 * `spend` is called before the request goes out and throws when there is no room, which is the
 * only ordering that can hold a ceiling: a check afterwards is a record of having exceeded it.
 * Teardown spends against the full total and everything else against the total less the reserve,
 * so the two share one number without the questions being able to eat the cleanup's share.
 */
export class RequestBudget {
  readonly total: number;
  readonly reserve: number;
  private spent = 0;

  constructor(total = PROBE_REQUEST_BUDGET, reserve = PROBE_TEARDOWN_RESERVE) {
    if (!Number.isInteger(total) || total <= 0)
      throw new Error('A request budget is a positive integer.');
    if (!Number.isInteger(reserve) || reserve < 0 || reserve >= total)
      throw new Error('A teardown reserve is a non-negative integer below the total.');
    this.total = total;
    this.reserve = reserve;
  }

  get used(): number {
    return this.spent;
  }

  /** What teardown could still spend. */
  get remaining(): number {
    return this.total - this.spent;
  }

  /** What a question could still spend, which is the smaller number and the one steps read. */
  get remainingForQuestions(): number {
    return Math.max(0, this.total - this.reserve - this.spent);
  }

  spend(label: string, options: { teardown?: boolean } = {}): number {
    const ceiling = options.teardown === true ? this.total : this.total - this.reserve;
    if (this.spent >= ceiling) throw new ProbeBudgetExhaustedError(label, this.spent, ceiling);
    this.spent += 1;
    return this.spent;
  }
}

import type { ProviderAgentCostList } from '../../shared/agent-cost.ts';

/**
 * How this app reads provider-reported agent usage, beside agent coordination rather than inside it.
 *
 * One interface that can only list usage figures — no submit, no enforcement, no local token
 * counting — so a cost panel cannot widen into billing control by accident.
 */
export interface AgentCostProvider {
  /** False leaves the caller a state to render rather than an exception to swallow. */
  readonly available: boolean;
  /** The provider's current usage rows for the reporting window it exposes. */
  list(): Promise<ProviderAgentCostList>;
}

/** The provider when agent cost is not configured. */
export class UnavailableAgentCostProvider implements AgentCostProvider {
  readonly available = false;
  private readonly reason: string;
  constructor(reason = 'Agent cost needs CURSOR_ADMIN_API_KEY.') {
    this.reason = reason;
  }
  private fail(): never {
    throw new Error(this.reason);
  }
  async list(): Promise<ProviderAgentCostList> {
    return this.fail();
  }
}
